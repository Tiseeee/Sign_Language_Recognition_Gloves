"""
一维 CNN —— 适配 12 特征双手手势数据

输入格式:
  - JSON: {"left":{"thumb":0.25,...,"wrist":0.00},"right":{...}}
  - CSV:  0.25,0.50,...,0.05  (前6个=左手, 后6个=右手)
  - 张量: (batch, 1, 12)  即 1 通道 × 12 个时序点
"""
import torch
import torch.nn as nn
import torch.nn.functional as F


class HandGestureCNN1D(nn.Module):
    """
    一维卷积神经网络，用于双手手势分类。

    输入形状: (batch, 1, 12)
        12 个特征点按顺序: L_thumb, L_index, L_middle, L_ring, L_pinky, L_wrist,
                           R_thumb, R_index, R_middle, R_ring, R_pinky, R_wrist

    架构:
        Conv1d(1→32, k=3) → ReLU → MaxPool(2)     # 12 → 6
        Conv1d(32→64, k=3) → ReLU → MaxPool(2)    # 6 → 3
        Flatten → FC(192→64) → Dropout → FC(64→num_classes)
    """

    def __init__(self, num_classes: int = 2, dropout: float = 0.5):
        """
        Args:
            num_classes: 分类类别数（默认 2，即二分类）
            dropout: Dropout 比例
        """
        super().__init__()

        # ---- 卷积层 ----
        self.conv1 = nn.Conv1d(
            in_channels=1, out_channels=32,
            kernel_size=3, padding=1
        )
        self.bn1 = nn.BatchNorm1d(32)
        self.pool1 = nn.MaxPool1d(kernel_size=2)          # 12 → 6

        self.conv2 = nn.Conv1d(
            in_channels=32, out_channels=64,
            kernel_size=3, padding=1
        )
        self.bn2 = nn.BatchNorm1d(64)
        self.pool2 = nn.MaxPool1d(kernel_size=2)          # 6 → 3

        # ---- 全连接层 ----
        self.fc1 = nn.Linear(64 * 3, 64)                  # 64通道 × 3长度 = 192
        self.dropout = nn.Dropout(dropout)
        self.fc2 = nn.Linear(64, num_classes)

        # ---- 权重初始化 ----
        self._init_weights()

    def _init_weights(self):
        for m in self.modules():
            if isinstance(m, nn.Conv1d):
                nn.init.kaiming_normal_(m.weight, mode='fan_out', nonlinearity='relu')
                if m.bias is not None:
                    nn.init.constant_(m.bias, 0)
            elif isinstance(m, nn.BatchNorm1d):
                nn.init.constant_(m.weight, 1)
                nn.init.constant_(m.bias, 0)
            elif isinstance(m, nn.Linear):
                nn.init.kaiming_normal_(m.weight, mode='fan_out', nonlinearity='relu')
                nn.init.constant_(m.bias, 0)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        """
        Args:
            x: (batch, 1, 12)
        Returns:
            logits: (batch, num_classes)
        """
        x = self.pool1(F.relu(self.bn1(self.conv1(x))))   # (B, 32, 6)
        x = self.pool2(F.relu(self.bn2(self.conv2(x))))   # (B, 64, 3)
        x = x.view(x.size(0), -1)                          # (B, 192)
        x = F.relu(self.fc1(x))
        x = self.dropout(x)
        x = self.fc2(x)                                    # (B, num_classes)
        return x


# ==============================
#  便捷工厂函数
# ==============================

def create_model(num_classes: int = 2, dropout: float = 0.5) -> HandGestureCNN1D:
    """创建模型并移至可用设备。"""
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model = HandGestureCNN1D(num_classes=num_classes, dropout=dropout).to(device)
    return model, device


# ==============================
#  快速测试
# ==============================

if __name__ == "__main__":
    model, device = create_model(num_classes=5)
    print(f"设备: {device}")
    print(f"模型参数量: {sum(p.numel() for p in model.parameters()):,}")

    # 模拟 12 特征输入
    dummy = torch.randn(4, 1, 12).to(device)
    with torch.no_grad():
        out = model(dummy)
    print(f"输入:  {dummy.shape}  →  输出: {out.shape}")
    print("模型结构:\n", model)
