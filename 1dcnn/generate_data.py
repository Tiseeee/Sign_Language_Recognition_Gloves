"""
生成模拟双手手势数据 — 带标签

手势定义 (5 类):
  label=0  张开手掌  Open    — 五指全伸 ≈ 1.0
  label=1  握拳      Fist    — 五指全弯 ≈ 0.0
  label=2  食指指    Point   — 仅食指伸直
  label=3  点赞      ThumbUp — 仅拇指伸直
  label=4  胜利V     Peace   — 食指+中指伸直

每个样本含 12 个特征:
  L_thumb, L_index, L_middle, L_ring, L_pinky, L_wrist,
  R_thumb, R_index, R_middle, R_ring, R_pinky, R_wrist

输出格式:
  --format json  →  data/{prefix}.json   (适合 JS/API 调用)
  --format csv   →  data/{prefix}.csv    (适合 Excel/Python 训练)

用法:
  python generate_data.py                           # 默认: 每类200条 → data/train.json
  python generate_data.py --samples 500             # 每类500条
  python generate_data.py --format csv              # 输出 CSV
  python generate_data.py --prefix test --samples 100  # 生成测试集
"""
import os
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")

import argparse
import json
import csv
import random
from pathlib import Path
from typing import List, Tuple

from labels import GESTURE_TEMPLATES, GESTURE_NAMES_EN, FINGER_ORDER, FINGER_MIN, FINGER_MAX, normalize_features

# 确保输出路径相对于脚本所在目录
SCRIPT_DIR = Path(__file__).resolve().parent


def add_noise(values: List[float], noise_level: float = 0.12) -> List[float]:
    """给手指值添加随机噪声, 按各手指范围 clamp"""
    result = []
    for i, v in enumerate(values):
        name = FINGER_ORDER[i % 6]
        mn = FINGER_MIN[name]
        mx = FINGER_MAX[name]
        noisy = v + random.uniform(-noise_level * (mx - mn), noise_level * (mx - mn))
        result.append(max(mn, min(mx, noisy)))
    return result


def generate_samples(
    samples_per_class: int = 200,
    noise_level: float = 0.12,
    seed: int = 42,
) -> List[dict]:
    """
    生成带标签的样本列表。

    Args:
        samples_per_class: 每类生成多少条
        noise_level: 噪声幅度（0=无噪声, ~0.15=较真实）
        seed: 随机种子

    Returns:
        列表，每项为 {"features": [12个float], "label": int, "gesture": str}
    """
    random.seed(seed)
    all_samples = []

    for label, template in GESTURE_TEMPLATES.items():
        for _ in range(samples_per_class):
            left = add_noise(template["left"], noise_level)
            right = add_noise(template["right"], noise_level)

            # 双手可以不完全一样（轻微独立噪声）
            if noise_level > 0:
                right = add_noise(template["right"], noise_level * 1.5)

            features = left + right  # 12 个值（传感器原始值）
            features = normalize_features(features)  # 归一化到 [0, 1]
            all_samples.append({
                "features": features,
                "label": label,
                "gesture": GESTURE_NAMES_EN.get(label, f"gesture_{label}"),
            })

    random.shuffle(all_samples)
    return all_samples


def save_json(samples: List[dict], filepath: Path):
    """保存为 JSON: 标准列表格式（每条 dict）"""
    records = []
    for s in samples:
        features = s["features"]
        records.append({
            "left": {
                "thumb": features[0], "index":  features[1],
                "middle": features[2], "ring":   features[3],
                "pinky":  features[4], "wrist":  features[5],
            },
            "right": {
                "thumb": features[6],  "index":  features[7],
                "middle": features[8],  "ring":   features[9],
                "pinky":  features[10], "wrist":  features[11],
            },
            "label": s["label"],
            "gesture": s["gesture"],  # 可选，方便人眼识别
        })
    filepath.parent.mkdir(parents=True, exist_ok=True)
    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(records, f, indent=2, ensure_ascii=False)
    print(f"✓ JSON 已保存: {filepath}  ({len(records)} 条)")


def save_csv(samples: List[dict], filepath: Path):
    """保存为 CSV: 每行 12 特征 + 标签"""
    filepath.parent.mkdir(parents=True, exist_ok=True)
    with open(filepath, "w", encoding="utf-8", newline="") as f:
        writer = csv.writer(f)
        # 写注释头
        writer.writerow([
            "# L_thumb", "L_index", "L_middle", "L_ring", "L_pinky", "L_wrist",
            "R_thumb", "R_index", "R_middle", "R_ring", "R_pinky", "R_wrist",
            "label"
        ])
        for s in samples:
            feat_strs = [f"{v:.4f}" for v in s["features"]]
            feat_strs.append(str(s["label"]))  # 标签保持整数
            writer.writerow(feat_strs)
    print(f"✓ CSV 已保存: {filepath}  ({len(samples)} 条)")


# ============================================================
#  main
# ============================================================

def main():
    parser = argparse.ArgumentParser(description="生成模拟双手手势数据集")
    parser.add_argument("--samples", type=int, default=400,
                        help="每类样本数 (默认200, 总样本=类别数×此值)")
    parser.add_argument("--noise", type=float, default=0.12,
                        help="噪声幅度 (0~0.3, 默认0.12)")
    parser.add_argument("--format", choices=["json", "csv", "both"],
                        default="both", help="输出格式 (默认both)")
    parser.add_argument("--prefix", default="train",
                        help="文件名前缀 (默认train)")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--outdir", default="data",
                        help="输出目录 (默认 ./data)")
    args = parser.parse_args()

    samples = generate_samples(
        samples_per_class=args.samples,
        noise_level=args.noise,
        seed=args.seed,
    )

    outdir = Path(args.outdir)
    if not outdir.is_absolute():
        outdir = SCRIPT_DIR / outdir

    # 统计各类别数量
    from collections import Counter
    counts = Counter(s["label"] for s in samples)
    print(f"\n总样本: {len(samples)} 条")
    for label in sorted(counts.keys()):
        name = GESTURE_NAMES_EN.get(label, f"gesture_{label}")
        print(f"  label={label} ({name:9s}): {counts[label]} 条")
    print()

    if args.format in ("json", "both"):
        save_json(samples, outdir / f"{args.prefix}.json")
    if args.format in ("csv", "both"):
        save_csv(samples, outdir / f"{args.prefix}.csv")


if __name__ == "__main__":
    main()
