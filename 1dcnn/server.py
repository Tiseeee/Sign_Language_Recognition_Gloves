"""
1D-CNN 手势识别 WebSocket 服务端

功能:
  - 加载训练好的 HandGestureCNN1D 模型
  - 通过 WebSocket 接收实时手势数据 (12 维特征向量)
  - 运行推理并返回识别结果 (手势名称 + 置信度)

协议:
  客户端 → 服务端: JSON
    {"features": [0.25, 0.50, ..., 0.05]}   # 12 个浮点数
    {"left": {"thumb":0.25,...}, "right": {...}}  # JSON 双手格式

  服务端 → 客户端: JSON
    {"label": 0, "name": "open", "name_cn": "张开手掌", "confidence": 0.95}
    {"label": -1, "name": "unknown", "name_cn": "未知", "confidence": 0.0}  # 低置信度或错误

用法:
  python server.py                          # 默认端口 8765
  python server.py --port 8766             # 自定义端口
  python server.py --model checkpoint.pth --threshold 0.6

依赖:
  pip install websockets torch numpy
"""

import os
# 修复 Anaconda 环境下的 OpenMP 库冲突
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")

import argparse
import asyncio
import json
import logging
import sys
from pathlib import Path
from typing import Optional

import numpy as np
import torch
import websockets
from websockets.asyncio.server import serve

# 将当前目录加入 path，确保能导入 cnn / labels 模块
sys.path.insert(0, str(Path(__file__).resolve().parent))

from cnn import HandGestureCNN1D
from labels import FINGER_ORDER, GESTURE_NAMES_EN, GESTURE_NAMES_CN, gesture_name

# ============================================================
#  日志配置
# ============================================================

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("GestureServer")

# ============================================================
#  模型推理器
# ============================================================

class GesturePredictor:
    """加载模型并对输入特征进行推理。"""

    def __init__(
        self,
        model_path: str,
        num_classes: int = 5,
        threshold: float = 0.5,
        device: Optional[str] = None,
    ):
        """
        Args:
            model_path: .pth 模型权重文件路径
            num_classes: 分类类别数
            threshold: 置信度阈值，低于此值返回 unknown
            device: 推理设备，None 则自动选择
        """
        self.threshold = threshold
        self.num_classes = num_classes

        # 设备
        if device is None:
            self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        else:
            self.device = torch.device(device)

        # 加载模型
        self.model = HandGestureCNN1D(num_classes=num_classes)
        state = torch.load(model_path, map_location=self.device, weights_only=True)
        self.model.load_state_dict(state)
        self.model.to(self.device)
        self.model.eval()

        logger.info(f"✅ 模型已加载: {model_path} (num_classes={num_classes})")
        logger.info(f"🖥️  推理设备: {self.device}")

    @torch.no_grad()
    def predict(self, features: list) -> dict:
        """
        对 12 维特征向量进行推理。

        Args:
            features: 12 个浮点数
                [L_thumb, L_index, L_middle, L_ring, L_pinky, L_wrist,
                 R_thumb, R_index, R_middle, R_ring, R_pinky, R_wrist]

        Returns:
            {"label": int, "name": str, "name_cn": str, "confidence": float}
        """
        if len(features) != 12:
            return {
                "label": -1,
                "name": "invalid",
                "name_cn": "无效数据",
                "confidence": 0.0,
                "error": f"特征长度应为 12，实际为 {len(features)}",
            }

        # (12,) → (1, 1, 12)
        tensor = torch.tensor(features, dtype=torch.float32).unsqueeze(0).unsqueeze(0)
        tensor = tensor.to(self.device)

        logits = self.model(tensor)  # (1, num_classes)
        probs = torch.softmax(logits, dim=-1).cpu().numpy()[0]

        pred_label = int(np.argmax(probs))
        confidence = float(probs[pred_label])

        if confidence < self.threshold:
            return {
                "label": -1,
                "name": "unknown",
                "name_cn": "未知",
                "confidence": confidence,
                "all_probs": {gesture_name(i): round(float(p), 4) for i, p in enumerate(probs)},
            }

        return {
            "label": pred_label,
            "name": GESTURE_NAMES_EN.get(pred_label, f"gesture_{pred_label}"),
            "name_cn": GESTURE_NAMES_CN.get(pred_label, f"手势{pred_label}"),
            "confidence": confidence,
            "all_probs": {gesture_name(i): round(float(p), 4) for i, p in enumerate(probs)},
        }


# ============================================================
#  特征提取辅助函数
# ============================================================

def extract_features(data: dict) -> Optional[list]:
    """
    从 WebSocket 接收的 JSON 中提取 12 维特征向量。

    支持格式:
      1) {"features": [0.25, ...]}   — 直接 12 维向量
      2) {"left": {...}, "right": {...}}  — 双手 JSON
      3) {"thumb": 0.25, "index": 0.50, ...}  — 单手 (默认当作左手)
    """
    # 格式1: 直接特征向量
    if "features" in data:
        feats = data["features"]
        if isinstance(feats, list) and len(feats) == 12:
            return [float(v) for v in feats]

    # 格式2: 双手 JSON
    if "left" in data or "right" in data:
        values = []
        for hand in ("left", "right"):
            hand_data = data.get(hand, {})
            if isinstance(hand_data, dict):
                for finger in FINGER_ORDER:
                    values.append(float(hand_data.get(finger, 0.0)))
            else:
                # 如果该手数据缺失，补 0
                values.extend([0.0] * len(FINGER_ORDER))
        if len(values) == 12:
            return values

    # 格式3: 单手 JSON (当作左手，右手补0)
    thumb_val = data.get("thumb")
    if thumb_val is not None:
        values = []
        for finger in FINGER_ORDER:
            values.append(float(data.get(finger, 0.0)))
        # 右手补 0
        values.extend([0.0] * len(FINGER_ORDER))
        return values

    return None


# ============================================================
#  WebSocket 连接处理器
# ============================================================

class ConnectionManager:
    """管理所有活跃的 WebSocket 连接，支持广播。"""

    def __init__(self):
        self.connections: set = set()

    async def register(self, websocket):
        self.connections.add(websocket)
        logger.info(f"🔗 新客户端连接 (当前 {len(self.connections)} 个)")

    async def unregister(self, websocket):
        self.connections.discard(websocket)
        logger.info(f"🔌 客户端断开 (剩余 {len(self.connections)} 个)")

    async def broadcast(self, message: str):
        """向所有连接的客户端广播消息。"""
        if not self.connections:
            return
        # 使用列表避免在迭代中修改集合
        websockets_list = [ws for ws in self.connections]
        # 并发发送
        results = await asyncio.gather(
            *[ws.send(message) for ws in websockets_list],
            return_exceptions=True,
        )
        for ws, result in zip(websockets_list, results):
            if isinstance(result, Exception):
                logger.warning(f"发送失败，移除连接: {result}")
                self.connections.discard(ws)


async def handler(websocket, predictor: GesturePredictor, manager: ConnectionManager):
    """WebSocket 连接处理协程。"""
    await manager.register(websocket)

    # 发送欢迎消息
    welcome = json.dumps({
        "type": "info",
        "message": "🤟 手势识别服务已连接",
        "num_classes": predictor.num_classes,
        "device": str(predictor.device),
    }, ensure_ascii=False)
    try:
        await websocket.send(welcome)
    except Exception:
        await manager.unregister(websocket)
        return

    try:
        async for raw_message in websocket:
            try:
                data = json.loads(raw_message)
            except json.JSONDecodeError as e:
                err_msg = json.dumps({
                    "type": "error",
                    "message": f"JSON 解析失败: {e}",
                }, ensure_ascii=False)
                await websocket.send(err_msg)
                continue

            # 提取特征
            features = extract_features(data)
            if features is None:
                err_msg = json.dumps({
                    "type": "error",
                    "message": "无法解析数据格式，请发送 {'features':[...]} 或 {'left':{...},'right':{...}}",
                    "received_keys": list(data.keys()) if isinstance(data, dict) else str(type(data)),
                }, ensure_ascii=False)
                await websocket.send(err_msg)
                continue

            # 推理
            result = predictor.predict(features)
            result["type"] = "prediction"

            # 日志
            if result.get("label", -1) >= 0:
                logger.info(
                    f"🎯 识别: {result['name_cn']} ({result['name']}) "
                    f"置信度: {result['confidence']:.2%}"
                )
            else:
                logger.info(f"❓ 未知手势 (max_conf={result['confidence']:.2%})")

            # 发送结果（也广播给其他客户端，方便多页面查看）
            response = json.dumps(result, ensure_ascii=False)
            await manager.broadcast(response)

    except websockets.exceptions.ConnectionClosed:
        pass
    except Exception as e:
        logger.error(f"处理消息时出错: {e}")
    finally:
        await manager.unregister(websocket)


# ============================================================
#  主入口
# ============================================================

def main():
    parser = argparse.ArgumentParser(description="1D-CNN 手势识别 WebSocket 服务")
    parser.add_argument("--host", default="0.0.0.0", help="监听地址 (默认 0.0.0.0)")
    parser.add_argument("--port", type=int, default=8765, help="监听端口 (默认 8765)")
    parser.add_argument("--model", default="checkpoint.pth", help="模型权重文件路径")
    parser.add_argument("--num-classes", type=int, default=5, help="分类类别数 (默认 5)")
    parser.add_argument("--threshold", type=float, default=0.5,
                        help="置信度阈值，低于此值返回 unknown (默认 0.5)")
    parser.add_argument("--device", default=None, help="推理设备 (cpu/cuda，默认自动)")
    args = parser.parse_args()

    # 模型路径处理
    model_path = Path(args.model)
    if not model_path.is_absolute():
        model_path = Path(__file__).resolve().parent / model_path
    if not model_path.exists():
        logger.error(f"❌ 模型文件不存在: {model_path}")
        sys.exit(1)

    # 初始化预测器
    predictor = GesturePredictor(
        model_path=str(model_path),
        num_classes=args.num_classes,
        threshold=args.threshold,
        device=args.device,
    )

    # 连接管理器
    manager = ConnectionManager()

    # 启动服务
    logger.info(f"🚀 WebSocket 服务启动: ws://{args.host}:{args.port}")
    logger.info(f"📊 类别数: {args.num_classes}, 阈值: {args.threshold}")

    async def serve_ws():
        async with serve(
            lambda ws: handler(ws, predictor, manager),
            args.host,
            args.port,
        ):
            logger.info("🟢 服务就绪，等待客户端连接...")
            await asyncio.get_running_loop().create_future()  # 永久运行

    try:
        asyncio.run(serve_ws())
    except KeyboardInterrupt:
        logger.info("⏹️  服务已停止")


if __name__ == "__main__":
    main()
