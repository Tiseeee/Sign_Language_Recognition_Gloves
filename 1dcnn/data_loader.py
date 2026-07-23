"""
双手手势数据加载器
支持 JSON 和 CSV 两种格式，输出统一为 (batch, 1, 12) 张量。

JSON 格式:
    {"left":{"thumb":0.25,"index":0.50,"middle":0.80,"ring":0.30,"pinky":0.10,"wrist":0.00},
     "right":{"thumb":0.30,"index":0.55,"middle":0.85,"ring":0.35,"pinky":0.15,"wrist":0.05},
     "label": 0}

CSV 格式 (每行一个样本):
    0.25,0.50,0.80,0.30,0.10,0.00,0.30,0.55,0.85,0.35,0.15,0.05,0
    说明: 前 6 个=左手(thumb→wrist), 中 6 个=右手(thumb→wrist), 最后 1 个=标签
"""
import json
import csv
from pathlib import Path
from typing import Union, List, Tuple, Optional

import torch
from torch.utils.data import Dataset, DataLoader

from labels import FINGER_ORDER


class HandGestureDataset(Dataset):
    """双手手势数据集，自动检测 JSON / CSV 格式。"""

    def __init__(self, file_path: Union[str, Path]):
        super().__init__()
        self.file_path = Path(file_path)
        self.samples: List[Tuple[torch.Tensor, int]] = []

        if not self.file_path.exists():
            raise FileNotFoundError(f"数据文件不存在: {self.file_path}")

        suffix = self.file_path.suffix.lower()
        if suffix == ".json":
            self._load_json()
        elif suffix == ".csv":
            self._load_csv()
        else:
            raise ValueError(f"不支持的文件格式: {suffix}，仅支持 .json / .csv")

    # ---------- JSON 解析 ----------
    def _load_json(self):
        with open(self.file_path, "r", encoding="utf-8") as f:
            data = json.load(f)

        # 支持两种 JSON 结构:
        #   A) 列表: [{"left":{...},"right":{...},"label":0}, ...]
        #   B) 单条: {"left":{...},"right":{...},"label":0}
        if isinstance(data, list):
            records = data
        elif isinstance(data, dict):
            records = [data]
        else:
            raise ValueError("JSON 顶层必须是列表或字典")

        for rec in records:
            features = self._parse_one_json(rec)
            label = int(rec.get("label", 0))
            self.samples.append((features, label))

    def _parse_one_json(self, rec: dict) -> torch.Tensor:
        """从一条 JSON 记录提取 12 维特征向量 → (1, 12)"""
        left = rec.get("left", {})
        right = rec.get("right", {})

        values = []
        for finger in FINGER_ORDER:
            values.append(float(left.get(finger, 0.0)))
        for finger in FINGER_ORDER:
            values.append(float(right.get(finger, 0.0)))

        # (12,) → (1, 12)  即 1 通道 × 12 长度
        return torch.tensor(values, dtype=torch.float32).unsqueeze(0)

    # ---------- CSV 解析 ----------
    def _load_csv(self):
        with open(self.file_path, "r", encoding="utf-8") as f:
            reader = csv.reader(f)
            for row in reader:
                # 跳过空行和注释行
                row = [c.strip() for c in row if c.strip() != ""]
                if not row or row[0].startswith("#") or row[0].startswith("//"):
                    continue

                # 跳过表头行 (包含非数字字符)
                if not all(self._is_number(c) for c in row):
                    continue

                values = [float(v) for v in row]
                if len(values) < 13:
                    raise ValueError(
                        f"CSV 每行至少需要 13 列 (12个特征+1个标签)，"
                        f"当前行有 {len(values)} 列: {row}"
                    )
                features = torch.tensor(values[:12], dtype=torch.float32).unsqueeze(0)
                label = int(values[12])
                self.samples.append((features, label))

    @staticmethod
    def _is_number(s: str) -> bool:
        """检查字符串是否为数字 (含负号、小数点)"""
        try:
            float(s)
            return True
        except ValueError:
            return False

    # ---------- Dataset 接口 ----------
    def __len__(self) -> int:
        return len(self.samples)

    def __getitem__(self, idx: int) -> Tuple[torch.Tensor, int]:
        return self.samples[idx]

    @property
    def num_classes(self) -> int:
        """自动推断类别数"""
        labels = {label for _, label in self.samples}
        return max(labels) + 1


# ==============================
#  便捷函数
# ==============================

def build_dataloaders(
    train_path: Union[str, Path],
    test_path: Optional[Union[str, Path]] = None,
    val_path: Optional[Union[str, Path]] = None,
    batch_size: int = 32,
    num_workers: int = 0,
    test_ratio: float = 0.0,
    seed: int = 42,
) -> Tuple[DataLoader, DataLoader, Optional[DataLoader], int]:
    """
    构建训练 / 验证 / 测试 DataLoader。

    Args:
        train_path: 训练数据文件路径 (.json / .csv)
        test_path:  测试数据文件路径（可选）
        val_path:   验证数据文件路径（可选）
        batch_size: 批量大小
        num_workers: 数据加载子进程数
        test_ratio: 若 test_path 未提供，从训练集划出此比例作为测试集
        seed:       随机种子

    Returns:
        (train_loader, test_loader, val_loader, num_classes)
    """
    full_dataset = HandGestureDataset(train_path)

    if test_path is not None:
        train_dataset = full_dataset
        test_dataset = HandGestureDataset(test_path)
    elif test_ratio > 0:
        train_size = int((1 - test_ratio) * len(full_dataset))
        test_size = len(full_dataset) - train_size
        train_dataset, test_dataset = torch.utils.data.random_split(
            full_dataset, [train_size, test_size],
            generator=torch.Generator().manual_seed(seed),
        )
    else:
        raise ValueError("请提供 test_path 或设置 test_ratio > 0")

    val_dataset = HandGestureDataset(val_path) if val_path else None

    g = torch.Generator().manual_seed(seed)
    train_loader = DataLoader(
        train_dataset, batch_size=batch_size,
        shuffle=True, num_workers=num_workers,
        generator=g,
    )
    test_loader = DataLoader(
        test_dataset, batch_size=batch_size,
        shuffle=False, num_workers=num_workers,
    )
    val_loader = None
    if val_dataset is not None:
        val_loader = DataLoader(
            val_dataset, batch_size=batch_size,
            shuffle=False, num_workers=num_workers,
        )

    # 从完整数据集推断类别数
    if hasattr(train_dataset, 'num_classes'):
        num_classes = train_dataset.num_classes
    else:
        num_classes = full_dataset.num_classes

    return train_loader, test_loader, val_loader, num_classes


# ==============================
#  自检
# ==============================

if __name__ == "__main__":
    import tempfile

    # ---- 测试 JSON 格式 ----
    json_content = json.dumps([
        {"left": {"thumb":0.25,"index":0.50,"middle":0.80,"ring":0.30,"pinky":0.10,"wrist":0.00},
         "right":{"thumb":0.30,"index":0.55,"middle":0.85,"ring":0.35,"pinky":0.15,"wrist":0.05},
         "label":0},
        {"left": {"thumb":0.80,"index":0.75,"middle":0.60,"ring":0.40,"pinky":0.20,"wrist":0.10},
         "right":{"thumb":0.85,"index":0.70,"middle":0.55,"ring":0.35,"pinky":0.15,"wrist":0.05},
         "label":1},
    ])

    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
        f.write(json_content)
        json_path = f.name

    ds = HandGestureDataset(json_path)
    print(f"JSON 数据集: {len(ds)} 条, 类别数={ds.num_classes}")
    x, y = ds[0]
    print(f"  样本0: shape={x.shape}, label={y}")   # (1,12)

    # ---- 测试 CSV 格式 ----
    csv_content = (
        "0.25,0.50,0.80,0.30,0.10,0.00,0.30,0.55,0.85,0.35,0.15,0.05,0\n"
        "0.80,0.75,0.60,0.40,0.20,0.10,0.85,0.70,0.55,0.35,0.15,0.05,1\n"
    )
    with tempfile.NamedTemporaryFile(mode="w", suffix=".csv", delete=False) as f:
        f.write(csv_content)
        csv_path = f.name

    ds2 = HandGestureDataset(csv_path)
    print(f"CSV 数据集: {len(ds2)} 条, 类别数={ds2.num_classes}")
    x2, y2 = ds2[1]
    print(f"  样本1: shape={x2.shape}, label={y2}")

    # 清理
    Path(json_path).unlink(missing_ok=True)
    Path(csv_path).unlink(missing_ok=True)
    print("\n自检通过 ✓")
