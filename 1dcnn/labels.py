"""
标签词典 —— 统一管理所有手势标签定义

修改此文件即可同步更新所有模块。

============================================================
如何添加新手势:

  1. 在 GESTURE_NAMES_EN / GESTURE_NAMES_CN 添加映射
  2. 在 GESTURE_TEMPLATES 添加手指弯曲模板
  3. 无需修改其他任何文件！

示例:
  GESTURE_NAMES_EN[5] = "ok_sign"
  GESTURE_NAMES_CN[5] = "OK手势"
  GESTURE_TEMPLATES[5] = {
      "left":  [0.8, 0.8, 0.0, 0.0, 0.0, 0.0],
      "right": [0.8, 0.8, 0.0, 0.0, 0.0, 0.0],
  }
============================================================
"""

# ============================================================
#  手指顺序 (左右手各 6 指)
# ============================================================

FINGER_ORDER = ["thumb", "index", "middle", "ring", "pinky", "wrist"]

FINGER_NAMES_CN = ["拇指", "食指", "中指", "无名指", "小指", "手腕"]

# ============================================================
#  手指值范围 (传感器原始数据，非归一化)
#  thumb/index/middle/ring/pinky/wrist
# ============================================================

# 每根手指的最大值（完全伸直）
FINGER_MAX = {
    "thumb":  0.90,
    "index":  1.10,
    "middle": 1.25,
    "ring":   1.25,
    "pinky":  1.15,
    "wrist":  0.40,
}

# 每根手指的最小值（完全弯曲）
FINGER_MIN = {
    "thumb":  0.0,
    "index":  0.0,
    "middle": 0.0,
    "ring":   0.0,
    "pinky":  0.0,
    "wrist": -0.40,
}

# 归一化函数：将传感器原始值映射到 [0, 1]
def normalize_finger(name: str, raw_value: float) -> float:
    """将传感器原始值归一化到 0~1 范围 (0=完全弯曲, 1=完全伸直)"""
    mn = FINGER_MIN.get(name, 0.0)
    mx = FINGER_MAX.get(name, 1.0)
    if mx == mn:
        return 0.0
    return max(0.0, min(1.0, (raw_value - mn) / (mx - mn)))

# 批量归一化 12 维特征向量
def normalize_features(features: list) -> list:
    """将 12 维原始传感器值归一化到 [0, 1]"""
    result = []
    for i, name in enumerate(FINGER_ORDER * 2):  # 左手 + 右手
        result.append(normalize_finger(name, features[i]))
    return result


# ============================================================
#  标签 ↔ 名称 映射
#  label: int → name: str
# ============================================================

# 英文名 (用于文件命名、ESP32 代码等)
# 初始为空，通过网页面板采集样本时自动添加
GESTURE_NAMES_EN = {
    0: "1",  # 1
    1: "2",  # two
    2: "test",  # 测试
    3: "44",  # 测试数据
    4: "ty",  # ts
}

# 中文名 (用于可视化、打印输出等)
# 初始为空，通过网页面板采集样本时自动添加
GESTURE_NAMES_CN = {
    0: "1",
    1: "two",
    2: "测试",
    3: "测试数据",
    4: "ts",
}


def gesture_name(label: int, lang: str = "en") -> str:
    """根据标签编号获取手势名称"""
    if lang == "cn":
        return GESTURE_NAMES_CN.get(label, f"gesture_{label}")
    return GESTURE_NAMES_EN.get(label, f"gesture_{label}")


def all_labels() -> list:
    """返回所有已定义的标签编号 (排序)"""
    return sorted(GESTURE_NAMES_EN.keys())


# ============================================================
#  手势模板 (用于 generate_data.py 生成模拟数据)
#  值为传感器原始范围:
#    thumb:0~0.9  index:0~1.1  middle:0~1.25  ring:0~1.25  pinky:0~1.15  wrist:-0.4~0.4
#  伸直=接近最大值, 弯曲=接近最小值
# ============================================================

GESTURE_TEMPLATES = {}
