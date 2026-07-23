"""
训练脚本 —— 一键训练 + 评估 + 模型保存

用法:
    python train.py --train data/train.csv --test data/test.csv --epochs 50
    python train.py --train data/train.json --test_ratio 0.2 --epochs 30
"""
import argparse
import copy
from pathlib import Path

import torch
import torch.nn as nn

from cnn import HandGestureCNN1D, create_model
from data_loader import build_dataloaders


# ==============================
#  训练 & 评估
# ==============================

def train_one_epoch(model, loader, criterion, optimizer, device):
    model.train()
    running_loss = 0.0
    correct = 0
    total = 0

    for inputs, labels in loader:
        inputs, labels = inputs.to(device), labels.to(device)

        optimizer.zero_grad()
        outputs = model(inputs)
        loss = criterion(outputs, labels)
        loss.backward()
        optimizer.step()

        running_loss += loss.item() * inputs.size(0)
        _, predicted = torch.max(outputs, 1)
        total += labels.size(0)
        correct += (predicted == labels).sum().item()

    return running_loss / total, 100.0 * correct / total


@torch.no_grad()
def evaluate(model, loader, criterion, device):
    model.eval()
    running_loss = 0.0
    correct = 0
    total = 0

    for inputs, labels in loader:
        inputs, labels = inputs.to(device), labels.to(device)
        outputs = model(inputs)
        loss = criterion(outputs, labels)

        running_loss += loss.item() * inputs.size(0)
        _, predicted = torch.max(outputs, 1)
        total += labels.size(0)
        correct += (predicted == labels).sum().item()

    return running_loss / total, 100.0 * correct / total


# ==============================
#  主训练循环
# ==============================

def main():
    parser = argparse.ArgumentParser(description="1D-CNN 双手手势识别训练")
    parser.add_argument("--train", required=True, help="训练数据文件 (.json/.csv)")
    parser.add_argument("--test", default=None, help="测试数据文件 (.json/.csv)")
    parser.add_argument("--val", default=None, help="验证数据文件 (.json/.csv)")
    parser.add_argument("--test_ratio", type=float, default=0.2,
                        help="未提供 --test 时，从训练集划分的测试比例")
    parser.add_argument("--epochs", type=int, default=50, help="训练轮数")
    parser.add_argument("--batch_size", type=int, default=32)
    parser.add_argument("--lr", type=float, default=0.001, help="学习率")
    parser.add_argument("--dropout", type=float, default=0.5, help="Dropout 比例")
    parser.add_argument("--save", default="checkpoint.pth", help="模型保存路径")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--num_workers", type=int, default=0)
    args = parser.parse_args()

    # ---- 随机种子 ----
    torch.manual_seed(args.seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(args.seed)

    # ---- 数据加载 ----
    train_loader, test_loader, val_loader, num_classes = build_dataloaders(
        train_path=args.train,
        test_path=args.test,
        val_path=args.val,
        batch_size=args.batch_size,
        num_workers=args.num_workers,
        test_ratio=args.test_ratio,
        seed=args.seed,
    )

    print(f"训练集: {len(train_loader.dataset)} 条")
    print(f"测试集: {len(test_loader.dataset)} 条")
    if val_loader:
        print(f"验证集: {len(val_loader.dataset)} 条")
    print(f"类别数: {num_classes}")

    # ---- 模型 ----
    model, device = create_model(num_classes=num_classes, dropout=args.dropout)
    print(f"设备: {device}")
    print(f"参数量: {sum(p.numel() for p in model.parameters()):,}")

    criterion = nn.CrossEntropyLoss()
    optimizer = torch.optim.Adam(model.parameters(), lr=args.lr)

    # ---- 训练循环 ----
    best_acc = 0.0
    best_state = None

    for epoch in range(1, args.epochs + 1):
        train_loss, train_acc = train_one_epoch(
            model, train_loader, criterion, optimizer, device
        )
        test_loss, test_acc = evaluate(
            model, test_loader, criterion, device
        )

        # 打印
        val_str = ""
        if val_loader:
            val_loss, val_acc = evaluate(model, val_loader, criterion, device)
            val_str = f" | Val Loss: {val_loss:.4f}, Acc: {val_acc:.2f}%"

        print(
            f"Epoch {epoch:3d}/{args.epochs} | "
            f"Train Loss: {train_loss:.4f}, Acc: {train_acc:.2f}% | "
            f"Test Loss: {test_loss:.4f}, Acc: {test_acc:.2f}%"
            + val_str
        )

        # 保存最佳模型
        if test_acc > best_acc:
            best_acc = test_acc
            best_state = copy.deepcopy(model.state_dict())

    # ---- 保存最佳权重 ----
    save_path = Path(args.save)
    save_path.parent.mkdir(parents=True, exist_ok=True)
    torch.save(best_state, save_path)
    print(f"\n最佳模型已保存至: {save_path}  (Test Acc: {best_acc:.2f}%)")


if __name__ == "__main__":
    main()
