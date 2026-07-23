"""
数据可视化工具 — 手势数据探索 & 训练结果展示

用法:
  python visualization.py                          # 交互式菜单
  python visualization.py --data data/train.csv    # 可视化数据集
  python visualization.py --sample data/train.csv --label 2  # 查看某类手势
  python visualization.py --radar 0.25,0.50,...,0.05   # 单样本雷达图
"""
import argparse
import json
import csv
import sys
from pathlib import Path
from typing import List, Dict, Optional
from collections import Counter

import matplotlib
matplotlib.use("TkAgg")  # 兼容 Windows
import matplotlib.pyplot as plt
import matplotlib.ticker as ticker
import numpy as np

# 中文字体设置
plt.rcParams["font.sans-serif"] = ["SimHei", "Microsoft YaHei", "DejaVu Sans"]
plt.rcParams["axes.unicode_minus"] = False

from labels import FINGER_ORDER, GESTURE_NAMES_CN as GESTURE_NAMES, FINGER_NAMES_CN as FINGER_CN, gesture_name


# ============================================================
#  数据加载
# ============================================================

def load_data(filepath: str) -> List[Dict]:
    """加载 JSON 或 CSV 文件"""
    fp = Path(filepath)
    if not fp.exists():
        print(f"❌ 文件不存在: {filepath}")
        return []

    records = []

    if fp.suffix == ".json":
        with open(fp, "r", encoding="utf-8") as f:
            data = json.load(f)
        for rec in (data if isinstance(data, list) else [data]):
            left = rec.get("left", {})
            right = rec.get("right", {})
            features = [float(left.get(k, 0)) for k in FINGER_ORDER]
            features += [float(right.get(k, 0)) for k in FINGER_ORDER]
            records.append({
                "features": features,
                "label": int(rec.get("label", 0)),
                "gesture": rec.get("gesture", ""),
            })
    elif fp.suffix == ".csv":
        with open(fp, "r", encoding="utf-8") as f:
            reader = csv.reader(f)
            for row in reader:
                row = [c.strip() for c in row if c.strip()]
                if not row or row[0].startswith("#"):
                    continue
                try:
                    vals = [float(v) for v in row]
                except ValueError:
                    continue
                if len(vals) < 13:
                    continue
                records.append({
                    "features": vals[:12],
                    "label": int(vals[12]),
                })
    else:
        print(f"❌ 不支持的文件格式: {fp.suffix}")
        return []

    return records


def load_data_with_labels(filepath: str) -> Dict[int, List[List[float]]]:
    """按标签分组加载"""
    records = load_data(filepath)
    grouped: Dict[int, List[List[float]]] = {}
    for r in records:
        lbl = r["label"]
        grouped.setdefault(lbl, []).append(r["features"])
    return grouped


# ============================================================
#  图1: 各类别样本分布 (柱状图)
# ============================================================

def plot_class_distribution(data: Dict[int, List[List[float]]], title="类别分布"):
    labels = sorted(data.keys())
    counts = [len(data[l]) for l in labels]
    names = [GESTURE_NAMES.get(l, f"label {l}") for l in labels]
    colors = plt.cm.Set3(np.linspace(0, 1, len(labels)))

    fig, ax = plt.subplots(figsize=(8, 5))
    bars = ax.bar(names, counts, color=colors, edgecolor="white", linewidth=1.2)

    for bar, c in zip(bars, counts):
        ax.text(bar.get_x() + bar.get_width() / 2, bar.get_height() + max(counts) * 0.01,
                str(c), ha="center", va="bottom", fontsize=12, fontweight="bold")

    ax.set_ylabel("样本数", fontsize=12)
    ax.set_title(title, fontsize=14, fontweight="bold")
    ax.set_ylim(0, max(counts) * 1.15)
    fig.tight_layout()
    plt.show()


# ============================================================
#  图2: 各类别手指值对比 (分组柱状图)
# ============================================================

def plot_finger_comparison(data: Dict[int, List[List[float]]]):
    """每类手势的 12 个手指平均值对比"""
    labels = sorted(data.keys())
    n_labels = len(labels)
    n_fingers = 12

    # 计算各类别均值
    means = np.zeros((n_labels, n_fingers))
    for i, lbl in enumerate(labels):
        arr = np.array(data[lbl])
        means[i] = arr.mean(axis=0)

    # 颜色
    cmap = plt.cm.Set2
    colors = [cmap(i / n_labels) for i in range(n_labels)]

    x = np.arange(n_fingers)
    width = 0.7 / n_labels

    fig, ax = plt.subplots(figsize=(14, 5))

    for i, lbl in enumerate(labels):
        name = GESTURE_NAMES.get(lbl, f"label {lbl}")
        offset = (i - n_labels / 2 + 0.5) * width
        ax.bar(x + offset, means[i], width, label=name, color=colors[i],
               edgecolor="white", linewidth=0.5)

    # X 轴标签
    x_labels = [f"L_{f}" for f in FINGER_CN] + [f"R_{f}" for f in FINGER_CN]
    ax.set_xticks(x)
    ax.set_xticklabels(x_labels, fontsize=9)
    ax.axvline(x=5.5, color="gray", linestyle="--", alpha=0.5, linewidth=1)
    ax.text(2.5, -0.12, "← 左手 →", transform=ax.get_xaxis_transform(),
            ha="center", fontsize=9, color="gray")
    ax.text(8.5, -0.12, "← 右手 →", transform=ax.get_xaxis_transform(),
            ha="center", fontsize=9, color="gray")

    ax.set_ylabel("手指弯曲值 (均值)", fontsize=12)
    ax.set_ylim(0, 1.15)
    ax.legend(loc="upper right", fontsize=9)
    ax.set_title("各类手势手指弯曲值对比", fontsize=14, fontweight="bold")
    fig.tight_layout()
    plt.show()


# ============================================================
#  图3: 单样本雷达图
# ============================================================

def plot_radar(features: List[float], title="手势样本"):
    """12 维特征的雷达图 (左/右各 6 维)"""
    angles = np.linspace(0, 2 * np.pi, 12, endpoint=False).tolist()
    angles += angles[:1]  # 闭合

    values = features + features[:1]
    left_angles = angles[:7]
    right_angles = [angles[6]] + angles[7:] + [angles[6]]

    left_vals = features[:6] + features[:1]
    right_vals = [features[6]] + features[6:] + [features[6]]

    fig, axes = plt.subplots(1, 2, subplot_kw=dict(polar=True), figsize=(10, 5))
    fig.suptitle(title, fontsize=14, fontweight="bold", y=1.02)

    for ax, vals, ang, hand, color in [
        (axes[0], left_vals, left_angles, "左手", "#4ECDC4"),
        (axes[1], right_vals, right_angles, "右手", "#FF6B6B"),
    ]:
        ax.fill(ang, vals, alpha=0.25, color=color)
        ax.plot(ang, vals, "o-", color=color, linewidth=2, markersize=6)
        ax.set_xticks(ang[:-1])
        ax.set_xticklabels(FINGER_CN, fontsize=10)
        ax.set_ylim(0, 1)
        ax.set_yticks([0.25, 0.5, 0.75, 1.0])
        ax.set_yticklabels(["0.25", "0.50", "0.75", "1.0"], fontsize=7, color="gray")
        ax.set_title(hand, fontsize=12, fontweight="bold", color=color)

    fig.tight_layout()
    plt.show()


# ============================================================
#  图4: 数据分布热力图
# ============================================================

def plot_heatmap(data: Dict[int, List[List[float]]]):
    """每个标签的 12 维特征均值热力图"""
    labels = sorted(data.keys())
    means = []
    for lbl in labels:
        arr = np.array(data[lbl])
        means.append(arr.mean(axis=0))

    means = np.array(means)

    fig, ax = plt.subplots(figsize=(12, 3 + len(labels) * 0.5))
    im = ax.imshow(means, cmap="YlOrRd", aspect="auto", vmin=0, vmax=1)

    y_labels = [GESTURE_NAMES.get(l, f"label {l}") for l in labels]
    x_labels = [f"L_{f}" for f in FINGER_CN] + [f"R_{f}" for f in FINGER_CN]

    ax.set_xticks(range(12))
    ax.set_xticklabels(x_labels, fontsize=9)
    ax.set_yticks(range(len(labels)))
    ax.set_yticklabels(y_labels, fontsize=10)

    # 在每个格子中标注数值
    for i in range(len(labels)):
        for j in range(12):
            ax.text(j, i, f"{means[i, j]:.2f}", ha="center", va="center",
                    fontsize=8, color="black" if means[i, j] < 0.5 else "white")

    # 左右手分界线
    ax.axvline(x=5.5, color="blue", linewidth=2, linestyle="--")
    ax.text(2.5, -0.8, "左手", ha="center", fontsize=10, fontweight="bold", color="blue")
    ax.text(8.5, -0.8, "右手", ha="center", fontsize=10, fontweight="bold", color="blue")

    cbar = plt.colorbar(im, ax=ax, shrink=0.8)
    cbar.set_label("弯曲值", fontsize=10)

    ax.set_title("各类别手指均值热力图", fontsize=14, fontweight="bold")
    fig.tight_layout()
    plt.show()


# ============================================================
#  图5: 原始手指值分布 (箱线图)
# ============================================================

def plot_boxplot(data: Dict[int, List[List[float]]]):
    """每类手势的箱线图 (只展示左手 6 指)"""
    labels = sorted(data.keys())
    n_labels = len(labels)

    fig, axes = plt.subplots(1, n_labels, figsize=(4 * n_labels, 5),
                              sharey=True, squeeze=False)
    axes = axes[0]

    for i, lbl in enumerate(labels):
        arr = np.array(data[lbl])[:, :6]  # 只用左手
        name = GESTURE_NAMES.get(lbl, f"label {lbl}")
        bp = axes[i].boxplot(arr, tick_labels=FINGER_CN,
                              patch_artist=True, showmeans=True,
                              meanprops=dict(marker="D", markerfacecolor="red", markersize=5))
        for patch in bp["boxes"]:
            patch.set_facecolor(plt.cm.Set2(i / n_labels))
        axes[i].set_title(f"{name}\n(label={lbl})", fontsize=11)
        axes[i].set_ylim(-0.1, 1.1)
        axes[i].tick_params(axis="x", rotation=30)

    axes[0].set_ylabel("手指弯曲值", fontsize=12)
    fig.suptitle("左手手指弯曲值分布 (箱线图)", fontsize=14, fontweight="bold")
    fig.tight_layout()
    plt.show()


# ============================================================
#  Main
# ============================================================

def main():
    parser = argparse.ArgumentParser(
        description="手势数据可视化工具",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  python visualization.py --data data/train.csv          # 全部分析
  python visualization.py --boxplot data/train.csv       # 箱线图
  python visualization.py --radar 0,0,1,0,0,0,0,1,0,0,0,0  # 雷达图
  python visualization.py --heatmap data/train.csv       # 热力图
        """,
    )

    parser.add_argument("--data", help="数据文件 (.json / .csv)")
    parser.add_argument("--radar", help="雷达图: 逗号分隔的12个值")
    parser.add_argument("--boxplot", help="箱线图数据文件")
    parser.add_argument("--heatmap", help="热力图数据文件")
    parser.add_argument("--all", action="store_true", help="显示所有图表")

    args = parser.parse_args()

    # ---- 雷达图 (单样本) ----
    if args.radar:
        try:
            features = [float(v) for v in args.radar.split(",")]
            if len(features) != 12:
                print(f"❌ 需要 12 个值，收到了 {len(features)} 个")
                return
            plot_radar(features, "手动输入手势样本")
        except ValueError:
            print("❌ 格式错误，请输入逗号分隔的数字")
        return

    # ---- 箱线图 ----
    if args.boxplot:
        data = load_data_with_labels(args.boxplot)
        if data:
            plot_boxplot(data)
        return

    # ---- 热力图 ----
    if args.heatmap:
        data = load_data_with_labels(args.heatmap)
        if data:
            plot_heatmap(data)
        return

    # ---- 数据集全部分析 ----
    if args.data or args.all:
        filepath = args.data
        if not filepath and args.all:
            # 自动找最近的 labeled 文件
            candidates = sorted(Path("data").glob("labeled_*.json"))
            if not candidates:
                candidates = sorted(Path("data").glob("train*.csv"))
            if candidates:
                filepath = str(candidates[-1])
                print(f"📂 自动选择: {filepath}")
            else:
                print("❌ 未找到数据文件，请用 --data 指定")
                return

        data = load_data_with_labels(filepath)
        if not data:
            return

        print(f"\n📊 数据概览: {filepath}")
        print(f"   总样本: {sum(len(v) for v in data.values())}")
        for lbl in sorted(data.keys()):
            print(f"   label {lbl} ({GESTURE_NAMES.get(lbl, '?')}): {len(data[lbl])} 条")

        plot_class_distribution(data)
        plot_finger_comparison(data)
        plot_heatmap(data)
        return

    # ---- 交互式菜单 ----
    print("\n" + "=" * 50)
    print("  手势数据可视化工具")
    print("=" * 50)
    print("  1 — 数据集全部分析 (分布+对比+热力图)")
    print("  2 — 箱线图")
    print("  3 — 热力图")
    print("  4 — 单样本雷达图")
    choice = input("\n请选择 [1-4]: ").strip()

    if choice == "1":
        filepath = input("数据文件路径: ").strip()
        data = load_data_with_labels(filepath)
        if data:
            plot_class_distribution(data)
            plot_finger_comparison(data)
            plot_heatmap(data)

    elif choice == "2":
        filepath = input("数据文件路径: ").strip()
        data = load_data_with_labels(filepath)
        if data:
            plot_boxplot(data)

    elif choice == "3":
        filepath = input("数据文件路径: ").strip()
        data = load_data_with_labels(filepath)
        if data:
            plot_heatmap(data)

    elif choice == "4":
        raw = input("输入 12 个手指值 (逗号分隔, 如 0,0,1,0,0,0,0,1,0,0,0,0): ").strip()
        try:
            features = [float(v) for v in raw.split(",")]
            if len(features) == 12:
                plot_radar(features, "自定义手势样本")
            else:
                print(f"❌ 需要 12 个值，收到了 {len(features)} 个")
        except ValueError:
            print("❌ 格式错误")

    else:
        print("❌ 无效选择")


if __name__ == "__main__":
    main()
