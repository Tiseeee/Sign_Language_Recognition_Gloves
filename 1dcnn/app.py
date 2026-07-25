"""
手势识别一体化服务 —— 网页 + WebSocket 推理 + 控制面板

一键启动，自动打开浏览器，网页上即可查看识别结果和控制服务。

用法:
  python app.py                          # 默认 HTTP:8080, WS:8765
  python app.py --http-port 3000 --ws-port 8766
  python app.py --no-browser             # 不自动打开浏览器

网页功能:
  - 实时显示 CNN 手势识别结果 (置信度、所有类别概率)
  - 服务状态指示 (绿色=运行中 / 红色=已停止)
  - 串口/BLE 连接控制
  - 语音播报

依赖:
  pip install websockets torch numpy
"""

import os
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")

import argparse
import asyncio
import json
import logging
import signal
import sys
import threading
import webbrowser
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from typing import Optional

import numpy as np
import torch
import websockets
from websockets.asyncio.server import serve

# 将当前目录加入 path
sys.path.insert(0, str(Path(__file__).resolve().parent))

from cnn import HandGestureCNN1D
from labels import FINGER_ORDER, GESTURE_NAMES_EN, GESTURE_NAMES_CN, gesture_name

# ============================================================
#  路径 & 日志
# ============================================================

BASE_DIR = Path(__file__).resolve().parent
WEB_DIR = BASE_DIR.parent / "Web"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("GestureApp")

# ============================================================
#  全局状态
# ============================================================

_app_running = True
_http_server: Optional[HTTPServer] = None
_ws_server = None
_connection_count = 0
_inference_count = 0
_start_time = None


# ============================================================
#  模型推理器 (同 server.py)
# ============================================================

class GesturePredictor:
    def __init__(self, model_path: str, num_classes: int = 6,
                 threshold: float = 0.5, device: Optional[str] = None):
        self.threshold = threshold
        self.num_classes = num_classes
        self.device = torch.device(device or ("cuda" if torch.cuda.is_available() else "cpu"))
        self.model = HandGestureCNN1D(num_classes=num_classes)
        state = torch.load(model_path, map_location=self.device, weights_only=True)
        self.model.load_state_dict(state)
        self.model.to(self.device)
        self.model.eval()
        logger.info(f"✅ 模型已加载 (num_classes={num_classes}, device={self.device})")

    @torch.no_grad()
    def predict(self, features: list) -> dict:
        if len(features) != 12:
            return {"label": -1, "name": "invalid", "name_cn": "无效数据",
                    "confidence": 0.0, "error": f"需要12维，收到{len(features)}维"}
        tensor = torch.tensor(features, dtype=torch.float32).unsqueeze(0).unsqueeze(0).to(self.device)
        probs = torch.softmax(self.model(tensor), dim=-1).cpu().numpy()[0]
        pred_label = int(np.argmax(probs))
        confidence = float(probs[pred_label])
        all_probs = {gesture_name(i): round(float(p), 4) for i, p in enumerate(probs)}
        if confidence < self.threshold:
            return {"label": -1, "name": "unknown", "name_cn": "未知",
                    "confidence": confidence, "all_probs": all_probs}
        return {
            "label": pred_label,
            "name": GESTURE_NAMES_EN.get(pred_label, f"gesture_{pred_label}"),
            "name_cn": GESTURE_NAMES_CN.get(pred_label, f"手势{pred_label}"),
            "confidence": confidence,
            "all_probs": all_probs,
        }


def extract_features(data: dict) -> Optional[list]:
    if "features" in data:
        feats = data["features"]
        if isinstance(feats, list) and len(feats) == 12:
            return [float(v) for v in feats]
    if "left" in data or "right" in data:
        values = []
        for hand in ("left", "right"):
            hd = data.get(hand, {})
            if isinstance(hd, dict):
                for finger in FINGER_ORDER:
                    values.append(float(hd.get(finger, 0.0)))
            else:
                values.extend([0.0] * len(FINGER_ORDER))
        if len(values) == 12:
            return values
    if data.get("thumb") is not None:
        values = [float(data.get(f, 0.0)) for f in FINGER_ORDER]
        values.extend([0.0] * len(FINGER_ORDER))
        return values
    return None


# ============================================================
#  WebSocket 处理
# ============================================================

class ConnectionManager:
    def __init__(self):
        self.connections: set = set()

    async def register(self, ws):
        self.connections.add(ws)
        global _connection_count
        _connection_count = len(self.connections)
        logger.info(f"🔗 客户端连接 (共 {_connection_count} 个)")

    async def unregister(self, ws):
        self.connections.discard(ws)
        global _connection_count
        _connection_count = len(self.connections)
        logger.info(f"🔌 客户端断开 (剩余 {_connection_count} 个)")

    async def broadcast(self, message: str):
        if not self.connections:
            return
        ws_list = list(self.connections)
        results = await asyncio.gather(
            *[ws.send(message) for ws in ws_list], return_exceptions=True)
        for ws, result in zip(ws_list, results):
            if isinstance(result, Exception):
                self.connections.discard(ws)


async def ws_handler(websocket, predictor: GesturePredictor, manager: ConnectionManager):
    await manager.register(websocket)
    try:
        await websocket.send(json.dumps({
            "type": "info",
            "message": "🤟 手势识别服务已连接",
            "num_classes": predictor.num_classes,
            "device": str(predictor.device),
        }, ensure_ascii=False))
    except Exception:
        await manager.unregister(websocket)
        return

    global _inference_count
    try:
        async for raw_message in websocket:
            # 检查是否是控制命令
            try:
                data = json.loads(raw_message)
            except json.JSONDecodeError:
                await websocket.send(json.dumps(
                    {"type": "error", "message": "JSON 解析失败"}, ensure_ascii=False))
                continue

            # 控制命令: 获取状态
            if data.get("cmd") == "status":
                import time as _time
                uptime = _time.time() - _start_time if _start_time else 0
                await websocket.send(json.dumps({
                    "type": "status",
                    "running": True,
                    "connections": _connection_count,
                    "inferences": _inference_count,
                    "uptime_seconds": round(uptime),
                    "model": predictor.num_classes,
                    "device": str(predictor.device),
                }, ensure_ascii=False))
                continue

            # 控制命令: 关闭服务
            if data.get("cmd") == "shutdown":
                await websocket.send(json.dumps(
                    {"type": "info", "message": "⏹️ 服务正在关闭..."}, ensure_ascii=False))
                logger.info("🛑 收到网页端关闭指令")
                shutdown()
                return

            # 推理请求
            features = extract_features(data)
            if features is None:
                await websocket.send(json.dumps({
                    "type": "error",
                    "message": "无法解析数据格式",
                    "received_keys": list(data.keys()) if isinstance(data, dict) else str(type(data)),
                }, ensure_ascii=False))
                continue

            _inference_count += 1
            result = predictor.predict(features)
            result["type"] = "prediction"

            if result.get("label", -1) >= 0:
                logger.info(f"🎯 {result['name_cn']} ({result['name']}) 置信度:{result['confidence']:.2%}")
            else:
                logger.info(f"❓ 未知手势 (max_conf={result['confidence']:.2%})")

            await manager.broadcast(json.dumps(result, ensure_ascii=False))

    except websockets.exceptions.ConnectionClosed:
        pass
    except Exception as e:
        logger.error(f"处理消息出错: {e}")
    finally:
        await manager.unregister(websocket)


# ============================================================
#  HTTP 服务器 (静态文件 + API)
# ============================================================

class AppHTTPHandler(SimpleHTTPRequestHandler):
    """自定义 HTTP 处理器：静态文件 + API 端点"""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB_DIR), **kwargs)

    def log_message(self, format, *args):
        # 抑制 HTTP 访问日志（减少终端噪音）
        pass

    def do_GET(self):
        # API: 服务状态
        if self.path == "/api/status":
            import time as _time
            uptime = _time.time() - _start_time if _start_time else 0
            data = {
                "running": _app_running,
                "connections": _connection_count,
                "inferences": _inference_count,
                "uptime_seconds": round(uptime),
                "ws_port": self.server.ws_port if hasattr(self.server, 'ws_port') else 8765,
            }
            self._json_response(data)
            return

        # API: 关闭服务
        if self.path == "/api/shutdown":
            self._json_response({"message": "服务正在关闭..."})
            logger.info("🛑 收到 HTTP 关闭指令")
            threading.Thread(target=shutdown, daemon=True).start()
            return

        # 默认：静态文件
        super().do_GET()

    def _json_response(self, data):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


# ============================================================
#  启动 / 关闭
# ============================================================

def shutdown():
    """优雅关闭所有服务"""
    global _app_running
    if not _app_running:
        return
    _app_running = False
    logger.info("⏹️  正在关闭服务...")

    # 停止 HTTP
    if _http_server:
        try:
            _http_server.shutdown()
        except Exception:
            pass

    # 停止事件循环（触发 WebSocket 服务关闭）
    try:
        loop = asyncio.get_event_loop()
        loop.call_soon_threadsafe(loop.stop)
    except Exception:
        pass

    logger.info("👋 服务已停止")


def start_http_server(port: int, ws_port: int):
    """在独立线程中启动 HTTP 服务器"""
    global _http_server
    server = HTTPServer(("0.0.0.0", port), AppHTTPHandler)
    server.ws_port = ws_port  # 附加 WS 端口信息
    _http_server = server
    logger.info(f"🌐 网页服务: http://localhost:{port}")
    try:
        server.serve_forever()
    except Exception:
        pass


async def start_ws_server(predictor: GesturePredictor, manager: ConnectionManager,
                          host: str, port: int):
    """启动 WebSocket 服务器"""
    global _ws_server
    logger.info(f"🔌 WebSocket: ws://{host}:{port}")
    async with serve(
        lambda ws: ws_handler(ws, predictor, manager),
        host, port,
    ) as server:
        _ws_server = server
        logger.info("🟢 全部服务就绪！")
        # 保持运行直到被停止
        while _app_running:
            await asyncio.sleep(0.5)
    logger.info("WebSocket 服务已关闭")


# ============================================================
#  主入口
# ============================================================

def main():
    global _start_time
    import time as _time

    parser = argparse.ArgumentParser(description="手势识别一体化服务")
    parser.add_argument("--http-port", type=int, default=8088, help="HTTP 网页端口 (默认 8088)")
    parser.add_argument("--ws-port", type=int, default=8765, help="WebSocket 端口 (默认 8765)")
    parser.add_argument("--host", default="0.0.0.0", help="监听地址")
    parser.add_argument("--model", default="checkpoint.pth", help="模型权重文件")
    parser.add_argument("--num-classes", type=int, default=6, help="分类类别数 (默认 6)")
    parser.add_argument("--threshold", type=float, default=0.5, help="置信度阈值")
    parser.add_argument("--device", default=None)
    parser.add_argument("--no-browser", action="store_true", help="不自动打开浏览器")
    args = parser.parse_args()

    # 模型路径
    model_path = Path(args.model)
    if not model_path.is_absolute():
        model_path = BASE_DIR / model_path
    if not model_path.exists():
        logger.error(f"❌ 模型不存在: {model_path}")
        sys.exit(1)

    if not WEB_DIR.exists():
        logger.error(f"❌ 网页目录不存在: {WEB_DIR}")
        sys.exit(1)

    # 初始化
    predictor = GesturePredictor(
        model_path=str(model_path),
        num_classes=args.num_classes,
        threshold=args.threshold,
        device=args.device,
    )
    manager = ConnectionManager()
    _start_time = _time.time()

    # 打印启动信息
    print()
    print("╔══════════════════════════════════════════════╗")
    print("║       🤟  手势识别一体化服务                  ║")
    print("╠══════════════════════════════════════════════╣")
    print(f"║  🌐 网页访问:  http://localhost:{args.http_port}       ║")
    print(f"║  🔌 WebSocket: ws://localhost:{args.ws_port}      ║")
    print(f"║  📊 手势类别:  {args.num_classes} 种                        ║")
    print("║                                              ║")
    print("║  在网页上可以:                                ║")
    print("║  • 查看实时识别结果                           ║")
    print("║  • 控制服务启停                               ║")
    print("║  • 连接串口/BLE 设备                          ║")
    print("║  • 语音播报识别结果                           ║")
    print("╚══════════════════════════════════════════════╝")
    print()
    print("  按 Ctrl+C 或在网页上点击停止按钮退出")
    print()

    # 启动 HTTP (线程)
    http_thread = threading.Thread(
        target=start_http_server,
        args=(args.http_port, args.ws_port),
        daemon=True,
    )
    http_thread.start()

    # 自动打开浏览器

    # 启动 WebSocket (主事件循环)
    try:
        asyncio.run(start_ws_server(predictor, manager, args.host, args.ws_port))
    except KeyboardInterrupt:
        logger.info("⏹️  Ctrl+C 收到，正在关闭...")
    finally:
        shutdown()


if __name__ == "__main__":
    main()
