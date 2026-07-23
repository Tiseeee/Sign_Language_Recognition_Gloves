# 1D-CNN 双手手势识别

基于一维卷积神经网络的双手手势分类系统，支持：

- 🎲 **生成模拟数据** — 快速验证模型
- 📡 **ESP32 实时采集** — 蓝牙 BLE / 串口 Serial 双模式
- 🏷️ **一键打标签** — 自动输出可训练格式
- 📊 **可视化分析** — 手指值对比 / 热力图 / 箱线图 / 雷达图
- 🚀 **训练 + 导出** — PyTorch 训练 → TFLite → ESP32 部署
- 🗂️ **标签集中管理** — 修改 `labels.py` 一处，全局生效

---

## 项目结构

```
1dcnn/
├── labels.py           ★ 标签词典 (修改标签只需改这一个文件)
├── cnn.py              模型定义 (HandGestureCNN1D)
├── train.py            训练脚本
├── data_loader.py      数据加载器 (JSON / CSV)
├── generate_data.py    模拟数据生成
├── collect_data.py     数据采集 (蓝牙 / 串口 + 监视器 + 合并)
├── visualization.py    数据可视化 (5种图表)
├── export_for_esp32.py PyTorch → TFLite 模型转换 & ESP32 部署
├── data/               数据文件目录
└── README.md
```

---

## 快速开始

### 1. 环境

```bash
conda activate 1dcnn
python -c "import torch; print(torch.__version__)"
```

Python 环境路径: `D:\anaconda\envs\1dcnn\python.exe`

### 2. 生成模拟数据

```bash
D:\anaconda\envs\1dcnn\python.exe generate_data.py --samples 200
```

输出 `data/train.json` + `data/train.csv`，各 1000 条 (5 类 × 200)。

### 3. 训练

```bash
D:\anaconda\envs\1dcnn\python.exe train.py --train data/train.csv --test_ratio 0.2 --epochs 60
```

---

## 数据格式

输入为 **12 维特征向量**，双手各 6 指弯曲程度（0.0 = 弯，1.0 = 直）：

```
左手: thumb, index, middle, ring, pinky, wrist
右手: thumb, index, middle, ring, pinky, wrist
```

**JSON**
```json
[{
  "left":  {"thumb": 0.25, "index": 0.50, "middle": 0.80, "ring": 0.30, "pinky": 0.10, "wrist": 0.00},
  "right": {"thumb": 0.30, "index": 0.55, "middle": 0.85, "ring": 0.35, "pinky": 0.15, "wrist": 0.05},
  "label": 0
}]
```

**CSV**
```csv
0.25,0.50,0.80,0.30,0.10,0.00,0.30,0.55,0.85,0.35,0.15,0.05,0
```

---

## 手势标签

默认定义 5 类手势，在 `labels.py` 中统一维护：

| label | 英文名 | 中文名 | 伸直的手指 |
|:-----:|--------|--------|-----------|
| 0 | open | 张开手掌 | 五指全伸 |
| 1 | fist | 握拳 | 五指全弯 |
| 2 | point | 食指指 | 仅食指 |
| 3 | thumb_up | 点赞 | 仅拇指 |
| 4 | peace | 胜利V | 食指 + 中指 |

---

## 模型架构

```
输入: (batch, 1, 12)
       ↓
Conv1d(1→32, k=3) → BatchNorm → ReLU → MaxPool(2)    # 12 → 6
       ↓
Conv1d(32→64, k=3) → BatchNorm → ReLU → MaxPool(2)   # 6 → 3
       ↓
Flatten → FC(192→64) → Dropout → FC(64→N_classes)
```

参数量 ~19K，轻量级。

---

## 命令行参考

### `train.py` — 训练

```bash
# 基本训练
D:\anaconda\envs\1dcnn\python.exe train.py --train data/train.csv --test data/test.csv

# 完整参数
D:\anaconda\envs\1dcnn\python.exe train.py ^
    --train data/train_all.csv ^
    --test data/test.csv ^
    --epochs 100 ^
    --batch_size 64 ^
    --lr 0.0005 ^
    --dropout 0.3 ^
    --save best_model.pth
```

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--train` | 必填 | 训练数据 (.json/.csv) |
| `--test` | — | 测试数据 (未提供则用 --test_ratio 划分) |
| `--test_ratio` | 0.2 | 从训练集划分比例 |
| `--epochs` | 50 | 训练轮数 |
| `--batch_size` | 32 | 批量大小 |
| `--lr` | 0.001 | 学习率 |
| `--dropout` | 0.5 | Dropout 比例 |
| `--save` | checkpoint.pth | 模型保存路径 |

### `generate_data.py` — 生成数据

```bash
D:\anaconda\envs\1dcnn\python.exe generate_data.py --samples 300 --noise 0.1 --format csv
```

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--samples` | 200 | 每类样本数 |
| `--noise` | 0.12 | 噪声幅度 (0~0.3) |
| `--format` | both | json / csv / both |
| `--prefix` | train | 文件名前缀 |
| `--outdir` | data | 输出目录 |

### `collect_data.py` — 数据采集

```bash
# 串口采集
D:\anaconda\envs\1dcnn\python.exe collect_data.py --mode serial --port COM3

# 蓝牙采集
D:\anaconda\envs\1dcnn\python.exe collect_data.py --mode ble --name "ESP32_Gesture"

# 监视模式 (不保存, 只实时打印)
D:\anaconda\envs\1dcnn\python.exe collect_data.py --monitor --port COM3

# 跳过标签交互
D:\anaconda\envs\1dcnn\python.exe collect_data.py --mode serial --port COM3 --label 0

# 交互式菜单 (无参数)
D:\anaconda\envs\1dcnn\python.exe collect_data.py
# → 1: 串口采集 | 2: 蓝牙采集 | 3: 串口监视

# 合并多次采集
D:\anaconda\envs\1dcnn\python.exe collect_data.py --merge data/labeled_*.json -o data/train_all.csv
```

| 参数 | 说明 |
|------|------|
| `--mode serial/ble` | 通信方式 |
| `--port COM3` | 串口号 |
| `--baud 115200` | 波特率 |
| `--name ESP32_xxx` | BLE 设备名称 (模糊匹配) |
| `--address AA:BB:...` | BLE MAC 地址 |
| `--monitor` | 串口监视模式 (仅查看, 不保存) |
| `--label 0` | 预填标签, 跳过交互 |
| `--merge a.json b.csv -o out.csv` | 合并多个文件 |

### `visualization.py` — 可视化

```bash
# 全部分析 (柱状图 + 手指对比 + 热力图)
D:\anaconda\envs\1dcnn\python.exe visualization.py --data data/train.csv

# 单独图表
D:\anaconda\envs\1dcnn\python.exe visualization.py --heatmap data/train.csv
D:\anaconda\envs\1dcnn\python.exe visualization.py --boxplot data/train.csv

# 单样本雷达图
D:\anaconda\envs\1dcnn\python.exe visualization.py --radar "0,1,0,0,0,0,0,1,0,0,0,0"

# 交互式菜单
D:\anaconda\envs\1dcnn\python.exe visualization.py
```

| 参数 | 说明 |
|------|------|
| `--data` | 数据文件, 弹出全部 3 张图 |
| `--heatmap` | 均值热力图 |
| `--boxplot` | 箱线图 |
| `--radar "0,0,1,..."` | 12 个手指值的雷达图 |

### `export_for_esp32.py` — 模型导出

```bash
D:\anaconda\envs\1dcnn\python.exe export_for_esp32.py checkpoint.pth --out gesture_model
```

| 参数 | 说明 |
|------|------|
| `--out` | 输出前缀 |
| `--num-classes 5` | 类别数 |
| `--quantize` | INT8 量化 (缩小 4x) |
| `--generate-h` | 同时生成 `.h` C 头文件 |
| `--method onnx/ai_edge` | 转换方式 |

---

## 完整工作流

```
ESP32-S3 → 蓝牙/串口 → collect_data.py → labeled_*.csv
                                               │
                                    多次采集 → --merge 合并
                                               ↓
generate_data.py ──────────────────────→ train_all.csv
                                               │
                                          train.py
                                               ↓
                                        checkpoint.pth
                                               │
                                      export_for_esp32.py
                                               ↓
                                      gesture_model.tflite
                                               ↓
                                        ESP32-S3 推理

train_all.csv ──→ visualization.py ──→ 数据图表
```

---

## 添加自定义手势

编辑 `labels.py` 的三处：

```python
# 1. 英文名
GESTURE_NAMES_EN[5] = "ok_sign"

# 2. 中文名
GESTURE_NAMES_CN[5] = "OK手势"

# 3. 手指模板 (generate_data.py 用)
GESTURE_TEMPLATES[5] = {
    "left":  [0.8, 0.8, 0.0, 0.0, 0.0, 0.0],
    "right": [0.8, 0.8, 0.0, 0.0, 0.0, 0.0],
}
```

所有模块自动同步：采集标签提示、可视化图表标注、ESP32 代码等无需手动修改。

---

## 推理示例

```python
import torch
from cnn import HandGestureCNN1D

model = HandGestureCNN1D(num_classes=5)
model.load_state_dict(torch.load("checkpoint.pth", weights_only=True))
model.eval()

# 食指指 (point)
x = torch.tensor([[
    [0.0, 1.0, 0.0, 0.0, 0.0, 0.0,
     0.0, 1.0, 0.0, 0.0, 0.0, 0.0]
]], dtype=torch.float32)  # (1, 1, 12)

with torch.no_grad():
    pred = torch.argmax(model(x), dim=1).item()
    print(f"预测: {pred}")  # → 2
```

## 依赖

```bash
pip install torch                # 必需
pip install pyserial             # 串口采集
pip install bleak                # 蓝牙采集
pip install matplotlib numpy     # 可视化
pip install onnx onnx2tf tensorflow  # 模型导出 (TFLite)
```
