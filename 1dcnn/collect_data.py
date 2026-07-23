"""
ESP32-S3 数据收集工具 — 蓝牙 / 串口双模式

============================================================
工作流程:
  1. 选择通信方式 (BLE 蓝牙 / Serial 串口)
  2. 连接 ESP32-S3 → 实时接收手势数据帧
  3. 按 Enter 停止采集
  4. 输入标签 (0~N)
  5. 自动生成带标签的训练文件

ESP32 端数据格式要求 (二选一):
  格式A (CSV行):  "0.25,0.50,0.80,0.30,0.10,0.00,0.30,0.55,0.85,0.35,0.15,0.05\\n"
                  12 个逗号分隔的浮点数

  格式B (JSON):   {"left":{"thumb":0.25,...,"wrist":0.00},"right":{...}}\\n
                  单行 JSON

输出文件:
  data/raw_session_20260724_153000.json    ← 原始采集数据 (不含标签)
  data/raw_session_20260724_153000.csv
  data/labeled_session_20260724_153000.json ← 带标签 (可直接训练)
  data/labeled_session_20260724_153000.csv
============================================================

用法:
  python collect_data.py                          # 交互式引导
  python collect_data.py --mode serial --port COM3 --baud 115200
  python collect_data.py --mode ble --name "ESP32_Gesture"
  python collect_data.py --mode serial --port COM3 --label 2  # 跳过交互直接用标签2
"""
import argparse
import json
import csv
import time
import sys
import threading
from pathlib import Path
from datetime import datetime
from typing import Optional, List

from labels import FINGER_ORDER, GESTURE_NAMES_EN, gesture_name

# ============================================================
#  依赖检查 (按需导入，缺失时给出安装提示)
# ============================================================

SERIAL_OK = False
BLE_OK = False

try:
    import serial
    import serial.tools.list_ports
    SERIAL_OK = True
except ImportError:
    pass

try:
    import asyncio
    from bleak import BleakScanner, BleakClient
    BLE_OK = True
except ImportError:
    pass

# ============================================================
#  全局状态
# ============================================================

_collected_frames: List[List[float]] = []  # 每条是 12 个 float
_collect_lock = threading.Lock()
_running = True
_line_buf = ""  # 行缓冲区：拼接串口/蓝牙碎片，解决分帧问题


def _add_frame(values: List[float]):
    """线程安全地添加一帧"""
    if len(values) == 12:
        with _collect_lock:
            _collected_frames.append([float(v) for v in values])


def parse_line(line: str) -> Optional[List[float]]:
    """
    解析 ESP32 发来的一行数据。
    返回 12 个 float 的列表，解析失败返回 None。
    """
    line = line.strip()
    if not line:
        return None

    # ---- 尝试 JSON 格式 ----
    if line.startswith("{"):
        try:
            obj = json.loads(line)
            values = []
            for hand in ("left", "right"):
                hand_data = obj.get(hand, {})
                for finger in FINGER_ORDER:
                    values.append(float(hand_data.get(finger, 0.0)))
            if len(values) == 12:
                return values
        except (json.JSONDecodeError, ValueError, TypeError):
            pass

    # ---- 尝试 CSV 格式 ----
    parts = [p.strip() for p in line.split(",") if p.strip() != ""]
    if len(parts) >= 12:
        try:
            return [float(p) for p in parts[:12]]
        except ValueError:
            pass

    return None


def _process_incoming(text: str, count: int, is_collect: bool = True) -> int:
    """
    处理收到的一行文本:
      - 解析 → 有效帧 → 打印 ✅ 并(采集模式下)保存
      - 无效行 → 打印 🔹 但不保存
    返回更新后的 count
    """
    text = text.strip()
    if not text:
        return count

    ts = datetime.now().strftime("%H:%M:%S.%f")[:-3]
    values = parse_line(text)

    if values is not None:
        if is_collect:
            _add_frame(values)
        count += 1
        l = values[:6]
        r = values[6:]
        print(f"{ts}  #{count:<5d} ✅ L:[{l[0]:.2f},{l[1]:.2f},{l[2]:.2f},{l[3]:.2f},{l[4]:.2f},{l[5]:.2f}]  R:[{r[0]:.2f},{r[1]:.2f},{r[2]:.2f},{r[3]:.2f},{r[4]:.2f},{r[5]:.2f}]")
    else:
        if len(text) > 76:
            text = text[:73] + "..."
        print(f"{ts}          🔹 {text}")

    return count


def serial_monitor(port: str, baud: int = 115200, timeout: float = 0.1):
    """
    串口监视器 —— 实时打印 ESP32 输出的所有数据，不保存。
    按 Ctrl+C 退出。
    """
    global _line_buf

    if not SERIAL_OK:
        print("❌ 需要安装 pyserial: pip install pyserial")
        return

    print(f"\n🔌 正在连接串口 {port} @ {baud} bps ...")
    try:
        ser = serial.Serial(port, baud, timeout=timeout)
    except serial.SerialException as e:
        print(f"❌ 无法打开串口 {port}: {e}")
        _list_serial_ports()
        return

    print(f"✅ 已连接 {port}")
    print("📡 实时监视中 (按 Ctrl+C 退出)...")
    print(f"{'─' * 78}")

    count = 0
    _line_buf = ""

    try:
        while True:
            try:
                chunk = ser.read(ser.in_waiting or 1).decode("utf-8", errors="replace")
            except serial.SerialException:
                print("\n⚠ 串口断开, 正在重连...")
                time.sleep(1)
                try:
                    ser.close()
                    ser = serial.Serial(port, baud, timeout=timeout)
                    print("✅ 已重连")
                except serial.SerialException:
                    continue
                continue

            if not chunk:
                continue

            _line_buf += chunk
            while "\n" in _line_buf:
                idx = _line_buf.index("\n")
                complete = _line_buf[:idx]
                _line_buf = _line_buf[idx + 1:]
                count = _process_incoming(complete, count, is_collect=False)

    except KeyboardInterrupt:
        print(f"\n{'─' * 78}")
        print("🛑 监视已停止")
    finally:
        ser.close()


# ============================================================
#  Serial 采集模式
# ============================================================

def collect_serial(port: str, baud: int = 115200, timeout: float = 0.1):
    """
    通过串口从 ESP32 连续采集数据并实时打印。
    按 Enter 停止采集。
    """
    global _running, _line_buf

    if not SERIAL_OK:
        print("❌ 需要安装 pyserial: pip install pyserial")
        return

    print(f"\n🔌 正在连接串口 {port} @ {baud} bps ...")
    try:
        ser = serial.Serial(port, baud, timeout=timeout)
    except serial.SerialException as e:
        print(f"❌ 无法打开串口 {port}: {e}")
        _list_serial_ports()
        return

    print(f"✅ 已连接 {port}")
    print("📡 开始采集 (按 Enter 停止)...")
    print(f"{'─' * 78}")

    count = 0
    _line_buf = ""

    def wait_for_enter():
        global _running
        input()
        _running = False

    threading.Thread(target=wait_for_enter, daemon=True).start()

    try:
        while _running:
            try:
                chunk = ser.read(ser.in_waiting or 1).decode("utf-8", errors="replace")
            except serial.SerialException:
                break

            if not chunk:
                continue

            _line_buf += chunk
            while "\n" in _line_buf:
                idx = _line_buf.index("\n")
                complete = _line_buf[:idx]
                _line_buf = _line_buf[idx + 1:]
                count = _process_incoming(complete, count, is_collect=True)

    except KeyboardInterrupt:
        pass
    finally:
        ser.close()
        _running = False

    print(f"{'─' * 78}")
    print(f"✅ 采集完成，共保存 {len(_collected_frames)} 帧有效数据")
    return _collected_frames
    """列出可用串口"""
    if not SERIAL_OK:
        return
    ports = serial.tools.list_ports.comports()
    if ports:
        print("\n📋 可用串口:")
        for p in ports:
            print(f"    {p.device} — {p.description}")


# ============================================================
#  BLE 蓝牙模式
# ============================================================

def collect_ble(
    device_name: Optional[str] = None,
    device_address: Optional[str] = None,
    service_uuid: Optional[str] = None,
    char_uuid: Optional[str] = None,
    scan_timeout: float = 10.0,
):
    """
    通过 BLE 从 ESP32 采集数据。

    Args:
        device_name:    设备名称 (模糊匹配)
        device_address: MAC 地址 (精确匹配)
        service_uuid:   服务 UUID (默认扫描常见手势服务)
        char_uuid:      特征 UUID (默认自动发现 notify 特征)
        scan_timeout:   扫描超时 (秒)
    """
    global _running

    if not BLE_OK:
        print("❌ 需要安装 bleak: pip install bleak")
        return

    asyncio.run(_ble_main(
        device_name, device_address,
        service_uuid, char_uuid, scan_timeout,
    ))


async def _ble_main(device_name, device_address, service_uuid, char_uuid, scan_timeout):
    global _running

    # ---- 扫描设备 ----
    print(f"\n🔍 正在扫描 BLE 设备 (最长 {scan_timeout}s) ...")
    if device_name:
        print(f"   匹配名称: {device_name}")

    device = None
    if device_address:
        device = await BleakScanner.find_device_by_address(
            device_address, timeout=scan_timeout
        )
    elif device_name:
        device = await BleakScanner.find_device_by_filter(
            lambda d, ad: d.name and device_name.lower() in d.name.lower(),
            timeout=scan_timeout,
        )
    else:
        # 列出所有设备让用户选
        devices = await BleakScanner.discover(timeout=scan_timeout)
        if not devices:
            print("❌ 未发现任何 BLE 设备")
            return
        print("\n📋 发现的设备:")
        for i, d in enumerate(devices):
            print(f"  [{i}] {d.name or '(无名称)'}  —  {d.address}")
        try:
            idx = int(input("请选择设备编号: ").strip())
            device = devices[idx]
        except (ValueError, IndexError):
            print("❌ 无效选择")
            return

    if device is None:
        print("❌ 未找到匹配设备")
        return

    print(f"✅ 发现设备: {device.name} ({device.address})")
    print(f"🔗 正在连接...")

    # ---- 回调: 接收通知 ----
    count = 0
    global _line_buf
    _line_buf = ""

    def notification_handler(sender, data):
        nonlocal count
        global _line_buf
        chunk = data.decode("utf-8", errors="replace")
        _line_buf += chunk
        while "\n" in _line_buf:
            idx = _line_buf.index("\n")
            complete = _line_buf[:idx]
            _line_buf = _line_buf[idx + 1:]
            count = _process_incoming(complete, count, is_collect=True)
        line = data.decode("utf-8", errors="replace")
        text = line.strip()
        if not text:
            return

        ts = datetime.now().strftime("%H:%M:%S.%f")[:-3]
        values = parse_line(text)

        if values is not None:
            _add_frame(values)
            count += 1
            l = values[:6]
            r = values[6:]
            print(f"{ts}  #{count:<5d} ✅ L:[{l[0]:.2f},{l[1]:.2f},{l[2]:.2f},{l[3]:.2f},{l[4]:.2f},{l[5]:.2f}]  R:[{r[0]:.2f},{r[1]:.2f},{r[2]:.2f},{r[3]:.2f},{r[4]:.2f},{r[5]:.2f}]")
        else:
            if len(text) > 76:
                text = text[:73] + "..."
            print(f"{ts}          🔹 {text}")

    async with BleakClient(device.address) as client:
        print(f"✅ 已连接: {device.name}")

        # 找到可用的 notify 特征
        target_char = None
        services = client.services

        if char_uuid:
            # 用户指定了 UUID
            target_char = char_uuid
        elif service_uuid:
            # 在指定服务下找 notify 特征
            for service in services:
                if service_uuid.lower() in service.uuid.lower():
                    for char in service.characteristics:
                        if "notify" in char.properties:
                            target_char = char.uuid
                            break
        else:
            # 自动发现: 找第一个支持 notify 的特征
            for service in services:
                for char in service.characteristics:
                    if "notify" in char.properties:
                        target_char = char.uuid
                        print(f"   自动选择特征: {char.uuid} ({char.description or ''})")
                        break
                if target_char:
                    break

        if target_char is None:
            print("❌ 未找到可用的 notify 特征，请用 --char-uuid 指定")
            print("   可用服务/特征:")
            for service in services:
                print(f"   服务: {service.uuid}")
                for char in service.characteristics:
                    print(f"      特征: {char.uuid}  props={char.properties}")
            return

        # 订阅通知
        await client.start_notify(target_char, notification_handler)
        print(f"{'─' * 78}")
        print("📡 开始采集 (按 Enter 停止)...")

        # 等待用户按 Enter 停止
        _running = True

        def stop_loop():
            global _running
            _running = False

        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, input)

        await client.stop_notify(target_char)

    print(f"{'─' * 78}")
    print(f"✅ 采集完成，共保存 {len(_collected_frames)} 帧有效数据")


# ============================================================
#  保存文件
# ============================================================

def save_raw(frames: List[List[float]], outdir: Path, session_id: str):
    """保存原始数据 (不含标签)"""
    outdir.mkdir(parents=True, exist_ok=True)

    # ---- JSON ----
    json_path = outdir / f"raw_{session_id}.json"
    records = []
    for fv in frames:
        records.append({
            "left": {
                "thumb": fv[0], "index": fv[1], "middle": fv[2],
                "ring": fv[3], "pinky": fv[4], "wrist": fv[5],
            },
            "right": {
                "thumb": fv[6], "index": fv[7], "middle": fv[8],
                "ring": fv[9], "pinky": fv[10], "wrist": fv[11],
            },
        })
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(records, f, indent=2, ensure_ascii=False)

    # ---- CSV ----
    csv_path = outdir / f"raw_{session_id}.csv"
    with open(csv_path, "w", encoding="utf-8", newline="") as f:
        writer = csv.writer(f)
        writer.writerow([
            "L_thumb", "L_index", "L_middle", "L_ring", "L_pinky", "L_wrist",
            "R_thumb", "R_index", "R_middle", "R_ring", "R_pinky", "R_wrist",
        ])
        for fv in frames:
            writer.writerow([f"{v:.4f}" for v in fv])

    print(f"\n📁 原始数据已保存:")
    print(f"   {json_path}  ({len(frames)} 帧)")
    print(f"   {csv_path}  ({len(frames)} 帧)")


def save_labeled(frames: List[List[float]], label: int,
                 gesture_name: str, outdir: Path, session_id: str):
    """保存带标签数据 (可直接用于训练)"""
    outdir.mkdir(parents=True, exist_ok=True)

    # ---- JSON ----
    json_path = outdir / f"labeled_{session_id}.json"
    records = []
    for fv in frames:
        records.append({
            "left": {
                "thumb": fv[0], "index": fv[1], "middle": fv[2],
                "ring": fv[3], "pinky": fv[4], "wrist": fv[5],
            },
            "right": {
                "thumb": fv[6], "index": fv[7], "middle": fv[8],
                "ring": fv[9], "pinky": fv[10], "wrist": fv[11],
            },
            "label": label,
            "gesture": gesture_name,
        })
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(records, f, indent=2, ensure_ascii=False)

    # ---- CSV ----
    csv_path = outdir / f"labeled_{session_id}.csv"
    with open(csv_path, "w", encoding="utf-8", newline="") as f:
        writer = csv.writer(f)
        writer.writerow([
            "# L_thumb", "L_index", "L_middle", "L_ring", "L_pinky", "L_wrist",
            "R_thumb", "R_index", "R_middle", "R_ring", "R_pinky", "R_wrist",
            "label",
        ])
        for fv in frames:
            writer.writerow([f"{v:.4f}" for v in fv] + [str(label)])

    print(f"\n📁 带标签数据已保存:")
    print(f"   {json_path}  ({len(frames)} 帧, label={label})")
    print(f"   {csv_path}  ({len(frames)} 帧, label={label})")


# ============================================================
#  合并工具: 将多个 labeled 文件合成一个训练集
# ============================================================

def merge_labeled_files(file_paths: List[str], output_path: str):
    """合并多个带标签的 JSON/CSV 文件为一个完整训练集"""
    all_records = []

    for fp in file_paths:
        fp = Path(fp)
        if not fp.exists():
            print(f"⚠ 跳过不存在的文件: {fp}")
            continue

        if fp.suffix == ".json":
            with open(fp, "r", encoding="utf-8") as f:
                all_records.extend(json.load(f))
        elif fp.suffix == ".csv":
            with open(fp, "r", encoding="utf-8") as f:
                reader = csv.reader(f)
                for row in reader:
                    row = [c.strip() for c in row if c.strip()]
                    if not row or row[0].startswith("#"):
                        continue
                    if len(row) < 13:
                        continue
                    try:
                        fv = [float(row[i]) for i in range(12)]
                        lbl = int(float(row[12]))
                    except ValueError:
                        continue
                    all_records.append({
                        "left": dict(zip(FINGER_ORDER, fv[:6])),
                        "right": dict(zip(FINGER_ORDER, fv[6:12])),
                        "label": lbl,
                    })

    if not all_records:
        print("❌ 没有有效数据可合并")
        return

    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)

    if output.suffix == ".json":
        with open(output, "w", encoding="utf-8") as f:
            json.dump(all_records, f, indent=2, ensure_ascii=False)
    elif output.suffix == ".csv":
        with open(output, "w", encoding="utf-8", newline="") as f:
            writer = csv.writer(f)
            writer.writerow([
                "L_thumb","L_index","L_middle","L_ring","L_pinky","L_wrist",
                "R_thumb","R_index","R_middle","R_ring","R_pinky","R_wrist","label"
            ])
            for rec in all_records:
                row = [rec["left"][k] for k in FINGER_ORDER]
                row += [rec["right"][k] for k in FINGER_ORDER]
                row.append(rec.get("label", 0))
                writer.writerow(row)

    from collections import Counter
    counts = Counter(r["label"] for r in all_records)
    print(f"\n✅ 合并完成 → {output}")
    print(f"   总样本: {len(all_records)}")
    for lbl, cnt in sorted(counts.items()):
        print(f"   label={lbl}: {cnt} 条")


# ============================================================
#  交互式标签输入
# ============================================================

def prompt_label() -> tuple:
    """交互式输入标签"""
    print("\n" + "=" * 50)
    print("🏷  请为本次采集的数据输入标签")
    print("=" * 50)
    for lbl in sorted(GESTURE_NAMES_EN.keys()):
        en = GESTURE_NAMES_EN[lbl]
        cn = gesture_name(lbl, "cn")
        print(f"  {lbl} — {cn} ({en})")
    print("  其它数字 — 自定义手势\n")

    while True:
        try:
            raw = input("请输入标签编号: ").strip()
            label = int(raw)
            if label < 0:
                print("  标签必须 >= 0，请重试")
                continue
            break
        except ValueError:
            print("  请输入整数，如 0, 1, 2 ...")
            continue

    name = gesture_name(label)
    if label in GESTURE_NAMES_EN:
        print(f"✅ 标签: {label} ({name})")
    else:
        custom_name = input(f"  自定义手势名称 (直接回车跳过): ").strip()
        if custom_name:
            name = custom_name

    return label, name


# ============================================================
#  Main
# ============================================================

def main():
    global _collected_frames

    parser = argparse.ArgumentParser(
        description="ESP32-S3 双手手势数据采集工具",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  python collect_data.py                                    # 交互式引导
  python collect_data.py --mode serial --port COM3          # 串口采集
  python collect_data.py --mode ble --name ESP32_Gesture    # 蓝牙采集
  python collect_data.py --mode serial --port COM3 --label 0   # 跳过交互
  python collect_data.py --merge labeled_1.json labeled_2.json -o merged.csv
        """,
    )
    parser.add_argument("--mode", choices=["serial", "ble"],
                        help="通信方式")
    parser.add_argument("--port", help="串口号 (如 COM3)")
    parser.add_argument("--baud", type=int, default=115200, help="串口波特率 (默认115200)")

    parser.add_argument("--name", help="BLE 设备名称 (模糊匹配)")
    parser.add_argument("--address", help="BLE MAC 地址")
    parser.add_argument("--service-uuid", help="BLE 服务 UUID")
    parser.add_argument("--char-uuid", help="BLE 特征 UUID (notify)")
    parser.add_argument("--scan-timeout", type=float, default=10.0,
                        help="BLE 扫描超时秒数 (默认10)")

    parser.add_argument("--label", type=int, default=None,
                        help="标签编号 (提供则跳过交互式输入)")
    parser.add_argument("--gesture-name", default=None,
                        help="手势名称 (配合 --label 使用)")

    parser.add_argument("--outdir", default="data",
                        help="输出目录 (默认 ./data)")
    parser.add_argument("--session", default=None,
                        help="会话ID (默认自动生成时间戳)")

    # 监视模式
    parser.add_argument("--monitor", action="store_true",
                        help="串口监视模式: 实时打印输出, 不保存")

    # 合并模式
    parser.add_argument("--merge", nargs="+", default=None,
                        help="合并多个 labeled 文件: --merge a.json b.csv ...")
    parser.add_argument("-o", "--output", default="data/merged_train.json",
                        help="合并输出路径 (配合 --merge)")

    args = parser.parse_args()

    # ---- 合并模式 ----
    if args.merge:
        merge_labeled_files(args.merge, args.output)
        return

    # ---- 监视模式 ----
    if args.monitor:
        if not args.port:
            _list_serial_ports()
            args.port = input("请输入串口号: ").strip()
        serial_monitor(args.port, args.baud)
        return

    # ---- 采集模式 ----
    # 自动生成 session ID
    session_id = args.session or datetime.now().strftime("%Y%m%d_%H%M%S")
    outdir = Path(args.outdir)

    # 交互式选择模式
    if not args.mode:
        print("\n" + "=" * 50)
        print("  ESP32-S3 手势数据采集工具")
        print("=" * 50)
        print("  选择通信方式:")
        print("    1 — 串口 (Serial / COM)")
        print("    2 — 蓝牙 (BLE)")
        print("    3 — 串口监视 (仅查看, 不保存)")

        choice = input("\n请选择 [1/2/3]: ").strip()

        if choice == "1":
            args.mode = "serial"
            if not args.port:
                _list_serial_ports()
                args.port = input("请输入串口号 (如 COM3): ").strip()
        elif choice == "2":
            args.mode = "ble"
            if not args.name and not args.address:
                args.name = input("请输入 BLE 设备名称 (直接回车则扫描所有): ").strip()
        elif choice == "3":
            if not args.port:
                _list_serial_ports()
                args.port = input("请输入串口号: ").strip()
            serial_monitor(args.port, args.baud)
            return
        else:
            print("❌ 无效选择")
            return

    # ---- 开始采集 ----
    _collected_frames = []

    if args.mode == "serial":
        if not args.port:
            _list_serial_ports()
            args.port = input("请输入串口号: ").strip()
        collect_serial(args.port, args.baud)

    elif args.mode == "ble":
        collect_ble(
            device_name=args.name,
            device_address=args.address,
            service_uuid=args.service_uuid,
            char_uuid=args.char_uuid,
            scan_timeout=args.scan_timeout,
        )

    frames = _collected_frames
    if not frames:
        print("❌ 未采集到任何数据")
        return

    # ---- 保存原始数据 ----
    save_raw(frames, outdir, session_id)

    # ---- 输入标签 ----
    if args.label is not None:
        label = args.label
        gname = args.gesture_name or gesture_name(label)
    else:
        label, gname = prompt_label()

    # ---- 保存带标签数据 ----
    save_labeled(frames, label, gname, outdir, session_id)

    print("\n" + "=" * 50)
    print("🎉 全部完成！")
    print(f"   采集帧数: {len(frames)}")
    print(f"   标签: {label} ({gname})")
    print()
    print("下一步：合并多个采集文件为一个训练集:")
    print(f"  python collect_data.py --merge data/labeled_*.json -o data/train_all.json")
    print()
    print("开始训练:")
    print(f"  python train.py --train data/train_all.json --test_ratio 0.2 --epochs 60")
    print("=" * 50)


if __name__ == "__main__":
    main()
