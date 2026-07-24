# 🖐️ 手部姿态模拟器 — Web 前端

基于 Three.js 的 3D 手部骨骼姿态可视化前端，支持 **蓝牙 BLE / USB 串口 / WebSocket** 三模连接，实时驱动 GLB 骨骼模型并展示手语识别结果。

---

## ✨ 功能特性

| 功能 | 说明 |
|------|------|
| 🦴 **3D 骨骼模型** | GLB 格式左右手模型，五指独立屈伸 + 手腕旋转 |
| 🔌 **三模连接** | 蓝牙 BLE + USB 串口 + WebSocket，任意组合使用 |
| 📡 **实时识别** | WebSocket 连接 Python 后端，显示中文手势名 + 置信度 |
| 🔊 **语音播报** | Web Speech API 中文朗读识别结果，右下角圆形按钮开关 |
| 🏷️ **标签转译** | `labels.js` 英文标签自动映射中文 (数字0-10 + 手势词汇) |
| 🔍 **蓝牙滤波** | 中值滤波(窗口5) + 变化率限制(0.15) + 低通平滑(0.3) |
| 📐 **自动校准** | 连接设备后自动采集基准值，完成后面板关闭 |
| 🎛️ **调试面板** | Tweakpane 独立调节每根手指、手腕旋转、握拳预设 |
| 🎨 **颜色自定义** | 手部肤色、衣物颜色实时可调 |
| ⚡ **可变采样率** | 10/20/50/100 Hz 四档切换 |

---

## 🚀 快速开始

### 方式一：一体化服务启动（推荐）

直接用 Python 后端托管前端静态文件，无需手动启动前端：

```bash
# 在项目根目录
python 1dcnn/app.py

# 浏览器访问 http://localhost:8088
```

### 方式二：Vite 开发服务器

```bash
cd Web
npm install
npm run dev

# 浏览器访问 http://localhost:5173
```

> 需要另外启动 WebSocket 推理服务：`python 1dcnn/server.py`

### 环境要求

- **Node.js** ≥ 16
- **Chrome / Edge**（需 Web Serial API）

---

## 📁 项目结构

```
Web/
├── index.html              # 入口页面（Three.js 场景容器）
├── main.js                 # Three.js 场景、模型加载、骨骼动画驱动
├── serial.js               # Web Serial + Web Bluetooth 双模通信
├── bluetooth.js            # Web Bluetooth + 三级数据滤波
├── websocket_client.js     # WebSocket 双向通信 + 识别结果展示
├── voice.js                # 语音播报模块（Web Speech API）
├── labels.js               # 标签映射表（英文 → 中文）
├── style.css               # 全局 UI 样式（连接面板/状态灯/浮层）
├── package.json            # Vite + Three.js + GSAP + Tweakpane
├── hand.glb                # 左手 3D 骨骼模型
├── righthand.glb           # 右手 3D 骨骼模型
├── logo.png                # Logo 图片
└── device/right/right.ino  # 右手 ESP32 固件
```

---

## 📡 通信架构

```
ESP32右手 ──BLE/Serial──▶  serial.js / bluetooth.js ──▶  main.js (3D渲染)
                                │
                                │ (数据转发)
                                ▼
                      websocket_client.js ──WebSocket──▶  Python app.py/server.py
                                │
                                ▼
                          voice.js (语音播报)  +  labels.js (标签转译)
```

---

## 🔌 连接方式

### 1. 蓝牙 BLE (`bluetooth.js` + `serial.js`)

- 使用 **Nordic UART Service (NUS)**
- 搜索名称以 `right` 开头的 BLE 设备
- 三级数据滤波保证平稳定：
  - **中值滤波**（窗口=5）— 去除偶发尖峰
  - **变化率限制**（max_delta=0.15）— 截断异常跳变
  - **低通平滑**（lerp=0.3）— 帧间平滑过渡

### 2. USB 串口 (`serial.js`)

- 使用 **Web Serial API**
- 自动识别 5 种数据格式：

| 格式 | 示例 |
|------|------|
| 单手 JSON | `{"thumb":0.25,"index":0.50,...,"wrist":0.00}` |
| 双手 JSON | `{"left":{...},"right":{...}}` |
| 标签格式 | `thumb:0.25,index:0.50,...,wrist:0.00` |
| 单手 CSV | `0.25,0.50,0.80,0.30,0.10,0.00` |
| 双手 CSV | `0.25,...,0.00,0.30,...,0.05` (12列) |

### 3. WebSocket (`websocket_client.js`)

- 自动连接 `ws://localhost:8765`
- 接收推理结果：`{name_cn:"你", confidence:0.95, all_probs:{...}}`
- 支持远程控制：`{cmd:"shutdown"}` 关闭后端

---

## 🎛️ 控制指令

通过串口或蓝牙发送 ASCII 指令：

| 指令 | 作用 |
|------|------|
| `FREQ:10` / `FREQ:20` / `FREQ:50` / `FREQ:100` | 切换采样频率 |
| `CAL` | 触发左右手同步校准 |

---

## 🛠️ 技术栈

| 技术 | 用途 |
|------|------|
| **Three.js** (0.152) | 3D 渲染引擎，GLB 骨骼动画 |
| **GSAP** | 动画过渡库 |
| **Tweakpane** | 实时参数调试面板 |
| **Vite** | 前端构建工具 |
| **Web Serial API** | USB 串口通信 |
| **Web Bluetooth API** | BLE 无线通信 |
| **WebSocket** | 双向实时推理通信 |
| **Web Speech API** | 浏览器原生中文语音播报 |

---

## 📄 License

仅供学习与研究使用。
