"""
手势识别一体化服务 —— Flask版本（更稳定）
"""
import os
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")

import argparse
import asyncio
import json
import logging
import subprocess
import sys
import threading
import time
import csv
from pathlib import Path

import numpy as np
import torch
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS

sys.path.insert(0, str(Path(__file__).resolve().parent))

from cnn import HandGestureCNN1D
from labels import (FINGER_ORDER, GESTURE_NAMES_EN, GESTURE_NAMES_CN,
                    gesture_name, normalize_features)

BASE_DIR = Path(__file__).resolve().parent
WEB_DIR = BASE_DIR.parent / "Web"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("GestureApp")

_predictor = None
_training_in_progress = False
_training_message = ""
connections = set()

app = Flask(__name__, static_folder=str(WEB_DIR), static_url_path='')
CORS(app)


class GesturePredictor:
    def __init__(self, model_path: str, num_classes: int = 2, device=None):
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
        if confidence < 0.5:
            return {"label": -1, "name": "unknown", "name_cn": "未知",
                    "confidence": confidence, "all_probs": all_probs}
        return {
            "label": pred_label,
            "name": GESTURE_NAMES_EN.get(pred_label, f"gesture_{pred_label}"),
            "name_cn": GESTURE_NAMES_CN.get(pred_label, f"手势{pred_label}"),
            "confidence": confidence,
            "all_probs": all_probs,
        }


def _reload_labels():
    global GESTURE_NAMES_EN, GESTURE_NAMES_CN
    import importlib
    import labels as _labels_mod
    importlib.reload(_labels_mod)
    GESTURE_NAMES_EN = _labels_mod.GESTURE_NAMES_EN
    GESTURE_NAMES_CN = _labels_mod.GESTURE_NAMES_CN
    if _predictor is not None:
        _predictor.num_classes = len(GESTURE_NAMES_EN)


def add_label_if_not_exists(label_name_en: str, label_name_cn: str) -> int:
    global GESTURE_NAMES_EN, GESTURE_NAMES_CN
    _reload_labels()
    for label_id, name in GESTURE_NAMES_EN.items():
        if name == label_name_en:
            return label_id
    new_id = max(GESTURE_NAMES_EN.keys()) + 1 if GESTURE_NAMES_EN else 0
    labels_path = BASE_DIR / "labels.py"
    content = labels_path.read_text(encoding="utf-8")
    import re

    def _replace_dict(match):
        prefix = match.group(1)
        inner = match.group(2).strip()
        dict_name = match.group(3)
        value = match.group(4)
        if inner == '':
            return f'{prefix}{{\n    {new_id}: {value},\n}}'
        else:
            return f'{prefix}{{\n{inner}\n    {new_id}: {value},\n}}'

    en_pattern = r'(GESTURE_NAMES_EN\s*=)(\s*\{[^}]*\})(.*?)(?=\n\ndef|\n# |\Z)'
    def _en_repl(m):
        return _replace_dict(re.match(r'(GESTURE_NAMES_EN\s*=)(\{[^}]*\})', m.group(0)))
    content = re.sub(
        r'GESTURE_NAMES_EN\s*=\s*\{[^}]*\}',
        lambda m: f'GESTURE_NAMES_EN = {{\n    {new_id}: "{label_name_en}",  # {label_name_cn}\n}}'
        if m.group(0).strip() == 'GESTURE_NAMES_EN = {}'
        else m.group(0).rstrip('}').rstrip() + f'\n    {new_id}: "{label_name_en}",  # {label_name_cn}\n}}',
        content,
        count=1
    )
    content = re.sub(
        r'GESTURE_NAMES_CN\s*=\s*\{[^}]*\}',
        lambda m: f'GESTURE_NAMES_CN = {{\n    {new_id}: "{label_name_cn}",\n}}'
        if m.group(0).strip() == 'GESTURE_NAMES_CN = {}'
        else m.group(0).rstrip('}').rstrip() + f'\n    {new_id}: "{label_name_cn}",\n}}',
        content,
        count=1
    )
    labels_path.write_text(content, encoding="utf-8")
    _reload_labels()
    return new_id


def append_sample_to_csv(features: list, label_id: int) -> bool:
    csv_path = BASE_DIR / "data" / "train.csv"
    csv_path.parent.mkdir(parents=True, exist_ok=True)
    if not csv_path.exists():
        with open(csv_path, "w", encoding="utf-8", newline="") as f:
            writer = csv.writer(f)
            writer.writerow([
                "# L_thumb", "L_index", "L_middle", "L_ring", "L_pinky", "L_wrist",
                "R_thumb", "R_index", "R_middle", "R_ring", "R_pinky", "R_wrist",
                "label"
            ])
    with open(csv_path, "a", encoding="utf-8", newline="") as f:
        writer = csv.writer(f)
        row = [f"{v:.4f}" for v in features] + [str(label_id)]
        writer.writerow(row)
    return True


def run_training_async():
    global _training_in_progress, _training_message, _predictor
    if _training_in_progress:
        return
    _training_in_progress = True
    _training_message = "训练中..."

    def _train_thread():
        global _training_in_progress, _training_message, _predictor
        try:
            _reload_labels()
            num_classes = len(GESTURE_NAMES_EN)

            csv_path = BASE_DIR / "data" / "train.csv"
            if not csv_path.exists():
                _training_message = "训练失败: 文件不存在"
                return
            with open(csv_path, "r", encoding="utf-8") as f:
                lines = f.readlines()
            data_lines = [l.strip() for l in lines if l.strip() and not l.strip().startswith("#")]
            if len(data_lines) == 0:
                _training_message = "训练失败: 数据为空，请先采集样本"
                return
            if num_classes == 0:
                _training_message = "训练失败: 没有标签"
                return

            _training_message = f"训练中 ({num_classes} 类, {len(data_lines)} 条)"

            result = subprocess.run(
                [sys.executable, str(BASE_DIR / "train.py"),
                 "--train", str(csv_path), "--epochs", "60"],
                cwd=str(BASE_DIR),
                capture_output=True, text=True, encoding="utf-8", errors="replace",
            )

            if result.returncode != 0:
                _training_message = f"训练失败: {result.stderr[-500:]}"
                logger.error(f"训练失败: {result.stderr[-500:]}")
                return

            model_path = BASE_DIR / "checkpoint.pth"
            if _predictor is not None and model_path.exists():
                state = torch.load(str(model_path), map_location=_predictor.device, weights_only=True)
                _predictor.model = HandGestureCNN1D(num_classes=num_classes)
                _predictor.model.load_state_dict(state)
                _predictor.model.to(_predictor.device)
                _predictor.model.eval()
                _predictor.num_classes = num_classes
                logger.info(f"✅ 模型已热重载 (num_classes={num_classes})")

            _training_message = f"训练完成 ({num_classes} 类)"
            logger.info(f"🎉 {_training_message}")

        except Exception as e:
            _training_message = f"训练出错: {str(e)}"
            logger.error(f"❌ 训练出错: {e}")
        finally:
            _training_in_progress = False

    threading.Thread(target=_train_thread, daemon=True).start()


@app.route('/')
def index():
    return send_from_directory(str(WEB_DIR), 'index.html')


@app.route('/api/status')
def api_status():
    return jsonify({"running": True, "num_classes": len(GESTURE_NAMES_EN)})


@app.route('/api/labels')
def api_labels():
    _reload_labels()
    labels_list = [
        {"id": k, "name_en": v, "name_cn": GESTURE_NAMES_CN.get(k, v)}
        for k, v in sorted(GESTURE_NAMES_EN.items())
    ]
    return jsonify({"labels": labels_list, "count": len(labels_list)})


@app.route('/api/train_status')
def api_train_status():
    return jsonify({"training": _training_in_progress, "message": _training_message})


@app.route('/api/train', methods=['POST'])
def api_train():
    if _training_in_progress:
        return jsonify({"ok": False, "error": "训练正在进行中"})
    run_training_async()
    return jsonify({"ok": True, "message": "训练已启动"})


@app.route('/api/collect_sample', methods=['POST'])
def api_collect():
    try:
        data = request.get_json()
        label_name_en = data.get("label_name_en", "").strip()
        label_name_cn = data.get("label_name_cn", "").strip() or label_name_en
        if not label_name_en:
            return jsonify({"ok": False, "error": "缺少英文标签"})

        feats = None
        if "features" in data:
            feats = data["features"]
        elif "left" in data or "right" in data:
            feats = []
            for hand in ("left", "right"):
                hd = data.get(hand, {})
                if isinstance(hd, dict):
                    for finger in FINGER_ORDER:
                        feats.append(float(hd.get(finger, 0.0)))
                else:
                    feats.extend([0.0] * len(FINGER_ORDER))

        if feats is None or len(feats) != 12:
            return jsonify({"ok": False, "error": "特征解析失败，需要12维"})

        feats = normalize_features(feats)
        label_id = add_label_if_not_exists(label_name_en, label_name_cn)
        append_sample_to_csv(feats, label_id)

        return jsonify({
            "ok": True,
            "label_id": label_id,
            "message": f"已采集样本 → {label_name_cn} (id={label_id})"
        })
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)})


@app.route('/api/clear_samples', methods=['POST'])
def api_clear():
    global GESTURE_NAMES_EN, GESTURE_NAMES_CN
    # 清空训练数据 CSV
    csv_path = BASE_DIR / "data" / "train.csv"
    if csv_path.exists():
        with open(csv_path, "w", encoding="utf-8", newline="") as f:
            writer = csv.writer(f)
            writer.writerow([
                "# L_thumb", "L_index", "L_middle", "L_ring", "L_pinky", "L_wrist",
                "R_thumb", "R_index", "R_middle", "R_ring", "R_pinky", "R_wrist",
                "label"
            ])
    # 清空 labels.py 中的标签字典
    labels_path = BASE_DIR / "labels.py"
    if labels_path.exists():
        content = labels_path.read_text(encoding="utf-8")
        import re
        # 将 GESTURE_NAMES_EN 和 GESTURE_NAMES_CN 替换为空字典
        content = re.sub(
            r'GESTURE_NAMES_EN\s*=\s*\{[^}]*\}',
            'GESTURE_NAMES_EN = {}',
            content
        )
        content = re.sub(
            r'GESTURE_NAMES_CN\s*=\s*\{[^}]*\}',
            'GESTURE_NAMES_CN = {}',
            content
        )
        content = re.sub(
            r'GESTURE_TEMPLATES\s*=\s*\{[^}]*\}',
            'GESTURE_TEMPLATES = {}',
            content
        )
        labels_path.write_text(content, encoding="utf-8")
        _reload_labels()
    # 清空已加载的模型（因为标签数变了，旧模型不再匹配）
    global _predictor
    _predictor = None
    return jsonify({"ok": True, "message": "训练数据和标签已全部清空"})


@app.route('/api/predict', methods=['POST'])
def api_predict():
    try:
        data = request.get_json()
        feats = None
        if "features" in data:
            feats = data["features"]
        elif "left" in data or "right" in data:
            feats = []
            for hand in ("left", "right"):
                hd = data.get(hand, {})
                if isinstance(hd, dict):
                    for finger in FINGER_ORDER:
                        feats.append(float(hd.get(finger, 0.0)))
                else:
                    feats.extend([0.0] * len(FINGER_ORDER))

        if feats is None or len(feats) != 12:
            return jsonify({"ok": False, "error": "特征解析失败，需要12维"})

        if _predictor is None:
            return jsonify({"ok": False, "error": "模型未加载"})

        result = _predictor.predict(feats)
        return jsonify(result)
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)})


@app.route('/api/explain_gesture', methods=['POST'])
def api_explain_gesture():
    try:
        from deepseek_client import explain_gesture
        data = request.get_json() or {}
        gesture_cn = data.get("gesture_cn", "")
        gesture_en = data.get("gesture_en", "")
        if not gesture_cn and not gesture_en:
            return jsonify({"ok": False, "error": "请提供手势名称"})
        result = explain_gesture(gesture_cn, gesture_en)
        return jsonify({"ok": True, "data": result})
    except Exception as e:
        logger.error(f"手势解释API错误: {e}")
        return jsonify({"ok": False, "error": str(e)})


@app.route('/api/predict_next', methods=['POST'])
def api_predict_next():
    try:
        from deepseek_client import predict_next_sentence
        data = request.get_json() or {}
        gesture_history = data.get("gesture_history", [])
        context = data.get("context", "")
        if not gesture_history:
            return jsonify({"ok": False, "error": "请提供手势历史"})
        result = predict_next_sentence(gesture_history, context)
        return jsonify({"ok": True, "data": result})
    except Exception as e:
        logger.error(f"下一句预测API错误: {e}")
        return jsonify({"ok": False, "error": str(e)})


def run_ws_server(ws_port):
    import websockets
    import asyncio

    async def handler(websocket):
        connections.add(websocket)
        logger.info(f"🔗 客户端连接 (共 {len(connections)} 个)")
        try:
            async for raw_message in websocket:
                try:
                    data = json.loads(raw_message)
                except:
                    continue

                feats = None
                if "features" in data:
                    feats = data["features"]
                elif "left" in data or "right" in data:
                    feats = []
                    for hand in ("left", "right"):
                        hd = data.get(hand, {})
                        if isinstance(hd, dict):
                            for finger in FINGER_ORDER:
                                feats.append(float(hd.get(finger, 0.0)))
                        else:
                            feats.extend([0.0] * len(FINGER_ORDER))

                if feats and len(feats) == 12:
                    if _predictor:
                        result = _predictor.predict(feats)
                        result["type"] = "prediction"
                        msg = json.dumps(result, ensure_ascii=False)
                        await websocket.send(msg)
                    else:
                        msg = json.dumps({
                            "type": "info",
                            "message": "模型未训练，请先采集样本并训练"
                        }, ensure_ascii=False)
                        await websocket.send(msg)
        except:
            pass
        finally:
            connections.discard(websocket)
            logger.info(f"🔌 客户端断开 (剩余 {len(connections)} 个)")

    async def main():
        async with websockets.serve(handler, "0.0.0.0", ws_port):
            logger.info(f"🔌 WebSocket: ws://0.0.0.0:{ws_port}")
            await asyncio.Future()

    asyncio.run(main())


def main():
    global _predictor

    # Windows GBK 终端无法打印 emoji，切换为 UTF-8 输出
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

    parser = argparse.ArgumentParser()
    parser.add_argument("--http-port", type=int, default=8088)
    parser.add_argument("--ws-port", type=int, default=8765)
    parser.add_argument("--model", default="checkpoint.pth")
    parser.add_argument("--num-classes", type=int, default=2)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()

    model_path = BASE_DIR / args.model
    if model_path.exists():
        try:
            _reload_labels()
            num_classes = len(GESTURE_NAMES_EN) or args.num_classes
            _predictor = GesturePredictor(str(model_path), num_classes=num_classes)
        except Exception as e:
            logger.warning(f"⚠️ 模型加载失败（可先采集样本后训练）: {e}")
            _predictor = None
    else:
        logger.warning(f"⚠️ 模型不存在: {model_path}，请先采集样本并训练")
        _predictor = None

    print(f"""
╔══════════════════════════════════════════════╗
║       🤟  手势识别一体化服务                  ║
╠══════════════════════════════════════════════╣
║  🌐 网页访问:  http://localhost:{args.http_port}       ║
║  🔌 WebSocket: ws://localhost:{args.ws_port}      ║
║  📊 手势类别:  {len(GESTURE_NAMES_EN)} 种                        ║
╚══════════════════════════════════════════════╝
    """)

    ws_thread = threading.Thread(target=run_ws_server, args=(args.ws_port,), daemon=True)
    ws_thread.start()

    app.run(host="0.0.0.0", port=args.http_port, debug=False, use_reloader=False)


if __name__ == "__main__":
    import numpy as np
    main()
