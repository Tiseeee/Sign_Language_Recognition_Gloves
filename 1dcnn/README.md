# 🧠 1D-CNN 双手手势识别

基于一维卷积神经网络的双手手势分类系统，覆盖 **数据生成 → 真机采集 → 训练 → 可视化 → 推理部署** 全流程。

---

## ✨ 功能概览

| 模块 | 文件 | 作用 |
|------|------|------|
| 🏷️ **标签管理** | `labels.py` | ★ 统一定义手势名称、模板、传感器范围、归一化函数 |
| 🎲 **模拟数据** | `generate_data.py` | 基于标签模板自动生成带噪声的训练数据 |
| 📡 **真机采集** | `collect_data.py` | ESP32 蓝牙 BLE / 串口 Serial 双模式实时采集 |
| 🧠 **模型训练** | `train.py` + `cnn.py` | 1D-CNN 训练 + 评估 + 保存最佳模型 |
| 📊 **数据可视化** | `visualization.py` | 柱状图/手指对比/热力图/箱线图/雷达图 |
| 🔌 **推理服务** | `app.py` + `server.py` | WebSocket 实时推理 + HTTP 网页托管 |
| 📦 **模型导出** | `export_for_esp32.py` | PyTorch → ONNX → TFLite + ESP32 C++ 代码 |

---

## 🚀 快速开始

### 环境

```bash
conda activate 1dcnn

# 安装依赖
pip install torch numpy websockets matplotlib pyserial bleak
# 或
pip install -r requirements_server.txt
```

### 一键体验

```bash
# 1. 生成模拟数据
python generate_data.py --samples 200 --noise 0.12

# 2. 训练
python train.py --train data/train.csv --test_ratio 0.2 --epochs 80 --batch_size 64

# 3. 启动一体化服务（自动打开浏览器）
python app.py --num-classes 3

# 访问 http://localhost:8088 即可看到 3D 手部模型
```

---

## 📁 项目结构

```
1dcnn/
├── labels.py               ★ 标签词典（改一处全局生效）
├── cnn.py                  模型定义 HandGestureCNN1D
├── train.py                训练脚本
├── data_loader.py          数据加载器（JSON/CSV）
├── generate_data.py        模拟数据生成
├── collect_data.py         真机数据采集（BLE/Serial）
├── visualization.py        数据可视化（5种图表）
├── app.py                  ★ 一体化服务（HTTP + WebSocket）
├── server.py               独立 WebSocket 推理服务
├── export_for_esp32.py     PyTorch → TFLite
├── checkpoint.pth          训练好的模型
├── requirements_server.txt 服务端依赖
└── data/                   数据集目录
```

---

## 🏷️ 标签管理 — `labels.py`

**所有手势相关的定义集中在此文件，添加新手势只需改这一处：**

### 当前手势（3 类）

| label | 英文 | 中文 | 右手手指状态 |
|:-----:|------|:--:|-------------|
| 0 | you | 你 | 仅食指伸直 |
| 1 | good | 好 | 拇指弯曲，其余四指伸直 |
| 2 | meet | 见面 | 拇指+无名指+小指伸直 |

### 添加新手势

```python
# 1. 添加名称映射
GESTURE_NAMES_EN[3] = "hello"
GESTURE_NAMES_CN[3] = "你好"

# 2. 添加手指模板（值为传感器原始范围，非归一化值）
GESTURE_TEMPLATES[3] = {
    "left":  [0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
    "right": [0.9, 1.1, 1.25, 1.25, 1.15, 0.0],  # 五指全伸
}
# 完成！generate_data.py / train.py / app.py 自动识别新手势
```

### 传感器归一化

`labels.py` 还定义了每根手指的物理范围及归一化函数：

```python
FINGER_MAX = {"thumb":0.90, "index":1.10, "middle":1.25, "ring":1.25, "pinky":1.15, "wrist":0.40}
FINGER_MIN = {"thumb":0.0, ..., "wrist":-0.40}

normalize_finger("index", 0.55)  # → 0.5（映射到 [0,1]）
normalize_features([raw_12_values])  # → [0~1] × 12
```

---

## 🎲 模拟数据生成 — `generate_data.py`

基于 `labels.py` 中的手势模板自动生成带噪声的训练数据。

```bash
# 默认：每类200条 → data/train.json + data/train.csv
python generate_data.py

# 自定义
python generate_data.py --samples 300 --noise 0.15 --format csv --prefix test --outdir data
```

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--samples` | 200 | 每类样本数 |
| `--noise` | 0.12 | 噪声幅度 (0~0.3) |
| `--format` | both | json / csv / both |
| `--prefix` | train | 文件名前缀 |
| `--outdir` | data | 输出目录 |

---

## 📡 真机采集 — `collect_data.py`

通过蓝牙 BLE 或 USB 串口连接 ESP32，实时接收并标注手势数据。

```bash
# 交互式菜单（推荐）
python collect_data.py

# 串口采集（跳过菜单）
python collect_data.py --mode serial --port COM3

# 蓝牙采集
python collect_data.py --mode ble --name "ESP32_Gesture"

# 监视模式（只看不存）
python collect_data.py --monitor --port COM3

# 指定标签（跳过交互）
python collect_data.py --mode serial --port COM3 --label 1

# 合并多次采集结果
python collect_data.py --merge data/labeled_*.json -o data/train_all.csv
```

**工作流：** 连接 ESP32 → 摆好手势 → 按 Enter 开始采集 → 按 Enter 停止 → 输入标签 → 自动生成 `labeled_*.json/csv`

| 参数 | 说明 |
|------|------|
| `--mode serial/ble` | 通信方式 |
| `--port COM3` | 串口号 |
| `--baud 115200` | 波特率 |
| `--name ESP32_xxx` | BLE 设备名（模糊匹配） |
| `--monitor` | 仅监视，不保存 |
| `--label 0` | 预填标签 |
| `--merge a.json b.csv -o out.csv` | 合并文件 |

---

## 🧠 模型训练 — `train.py`

```bash
# 基本训练
python train.py --train data/train.csv --test_ratio 0.2 --epochs 80

# 完整参数
python train.py --train data/train_all.csv --test data/test.csv `
    --epochs 100 --batch_size 64 --lr 0.0005 --dropout 0.3 --save best_model.pth
```

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--train` | 必填 | 训练数据 (.json/.csv) |
| `--test` | — | 测试数据（未提供则自动划分） |
| `--test_ratio` | 0.2 | 从训练集划分比例 |
| `--epochs` | 50 | 训练轮数 |
| `--batch_size` | 32 | 批量大小 |
| `--lr` | 0.001 | 学习率 |
| `--dropout` | 0.5 | Dropout 比例 |
| `--save` | checkpoint.pth | 模型保存路径 |

### 模型架构

```
输入: (batch, 1, 12)        ← 左手6指 + 右手6指

Conv1d(1→32,k=3) → BN → ReLU → MaxPool(2)    # 12 → 6
Conv1d(32→64,k=3) → BN → ReLU → MaxPool(2)   # 6 → 3
Flatten → FC(192→64) → Dropout → FC(64→N_classes)
```

**~19K 参数**，极轻量级，适合 ESP32 端侧部署。

---

## 📊 数据可视化 — `visualization.py`

支持 5 种图表，帮助分析数据质量：

```bash
# 全部分析
python visualization.py --data data/train.csv

# 单独图表
python visualization.py --heatmap data/train.csv    # 热力图
python visualization.py --boxplot data/train.csv    # 箱线图
python visualization.py --radar 0.25,0.50,...,0.05  # 单样本雷达图

# 查看某类手势
python visualization.py --sample data/train.csv --label 1
```

| 图表 | 说明 |
|------|------|
| 📊 类别分布 | 每类样本数量柱状图 |
| 📈 手指对比 | 各类别下每根手指的平均弯曲值 |
| 🔥 热力图 | 数据整体分布情况 |
| 📦 箱线图 | 每根手指的统计分布（中位数/四分位/异常值） |
| 🕸️ 雷达图 | 单个样本的 12 维特征可视化 |

---

## 🔌 推理服务

### `app.py` — 一体化服务（推荐）

单命令启动 HTTP 网页 + WebSocket 推理：

```bash
python app.py                                    # 默认 HTTP:8088, WS:8765
python app.py --http-port 3000 --ws-port 8766    # 自定义端口
python app.py --num-classes 3 --threshold 0.6    # 3类, 高阈值
python app.py --no-browser                       # 不自动开浏览器
```

- 启动后自动打开浏览器访问 `http://localhost:8088`
- 网页上可连接蓝牙/串口设备，看到实时识别结果
- HTTP API: `GET /api/status` `GET /api/shutdown`

### `server.py` — 独立 WebSocket 推理

```bash
python server.py --num-classes 3 --threshold 0.5 --port 8765
```

### WebSocket 协议

| 方向 | 格式 |
|------|------|
| 客户端→服务端 | `{"features":[0.25,0.50,...,0.05]}` (12维) |
|  | `{"left":{...},"right":{...}}` |
|  | `{"cmd":"status"}` / `{"cmd":"shutdown"}` |
| 服务端→客户端 | `{"type":"prediction","label":0,"name":"you","name_cn":"你","confidence":0.95,"all_probs":{...}}` |

---

## 📦 模型导出 — `export_for_esp32.py`

将训练好的 PyTorch 模型导出为 TFLite，供 ESP32 端侧推理：

```bash
python export_for_esp32.py checkpoint.pth --num-classes 3
python export_for_esp32.py checkpoint.pth --num-classes 3 --quantize   # INT8 量化
```

输出文件：`gesture_model.tflite` + `esp32_inference.cpp`（部署参考代码）。

> 依赖：`pip install onnx onnx2tf tensorflow`

---

## 📄 License

仅供学习与研究使用。
