# 🖐️ 手部姿态模拟器

基于 Three.js 的 3D 手部骨骼姿态模拟器，支持串口硬件数据输入与 WebSocket 实时检测结果展示。

## ✨ 功能特性

- **3D 手部模型** — 加载 GLB 格式的左手/右手骨骼模型，支持五指独立屈伸控制
- **双模连接** — Web Serial API（USB 有线）+ Web Bluetooth API（BLE 无线），自动检测并适配
- **串口通信** — 通过 Web Serial / Web Bluetooth 接收硬件手指数据，实时驱动 3D 手部骨骼动画
- **校准模式** — 连接后自动进入校准，逐行显示设备校准数据，校准完成后自动关闭面板
- **WebSocket 识别** — 连接 Python 后端服务，实时显示手语检测结果并中文转译
- **语音播报** — 检测结果自动语音朗读（可开关），按钮常驻右下角
- **标签映射** — 英文标签 → 中文翻译的映射表，方便扩展新词汇
- **手动控制面板** — 使用 Tweakpane 独立调节每根手指的弯曲角度、手腕旋转、握拳预设
- **颜色自定义** — 调节手部、衬衫、背心的颜色
- **右手镜像** — 左手动作自动同步到右手模型（可独立控制）

## 🚀 快速开始

### 环境要求

- Node.js >= 16
- Chrome 或 Edge 浏览器（需支持 Web Serial API）

### 安装运行

```bash
# 安装依赖
npm install

# 启动开发服务器
npm run dev

# 构建生产版本
npm run build

# 预览生产版本
npm run preview
```

启动后在浏览器中打开 `http://localhost:5173`。

## 🔌 串口 / 蓝牙连接

### 有线连接（USB Serial）

1. 点击底部工具栏的 **🔌 连接串口** 按钮
2. 在弹出窗口中选择对应的串口设备
3. 连接后自动进入校准模式，面板会显示设备传来的校准数据
4. 收到足够有效数据后校准完成，面板自动消失（约需 3 条有效数据）
5. 可通过频率下拉菜单调整采样频率（10/20/50/100 Hz）

### 无线连接（BLE 蓝牙）

1. 点击底部工具栏的 **📶 蓝牙** 按钮
2. 在弹出窗口中选择 BLE 设备（Nordic UART Service）
3. 连接后自动进入校准模式，流程同有线
4. 支持自定义 UUID：修改 `fingerSerial.bleServiceUUID` / `bleTxUUID` / `bleRxUUID`

### 串口数据格式

共支持 **5 种** 数据格式，键名固定为 `thumb` / `index` / `middle` / `ring` / `pinky` / `wrist`：

| 格式 | 示例 | 说明 |
|------|------|------|
| 单手 JSON | `{"thumb":0.25,"index":0.50,"middle":0.80,"ring":0.30,"pinky":0.10,"wrist":0.00}` | 左手数据，完整 JSON |
| 双手 JSON | `{"left":{...},"right":{...}}` | 左右手独立子对象，可只传一侧 |
| 标签格式 | `thumb:0.25,index:0.50,middle:0.80,ring:0.30,pinky:0.10,wrist:0.00` | 键值对逗号分隔，左手 |
| 单手 CSV | `0.25,0.50,0.80,0.30,0.10,0.00` | 6 个数值，左手 |
| 双手 CSV | `0.25,...,0.10, 0.30,...,0.05` | 12 个数值，前 6 左手后 6 右手 |

> 💡 详见 `serial.js` 文件头部的完整格式注释。

## 📡 WebSocket 检测

项目默认连接 `ws://localhost:8765`。后端需发送如下 JSON 格式数据：

```json
{
  "detections": [
    {
      "label": "person",
      "confidence": 0.95,
      "bbox": [x1, y1, x2, y2]
    }
  ]
}
```

检测结果会显示在页面顶部居中位置。

## 🛠️ 技术栈

- [Vite](https://vitejs.dev/) — 构建工具
- [Three.js](https://threejs.org/) — 3D 渲染引擎
- [Tweakpane](https://tweakpane.github.io/docs/) — 控制面板
- [GSAP](https://gsap.com/) — 动画库
- Web Serial API — USB 串口通信
- Web Bluetooth API — BLE 无线通信
- Web Speech API — 语音播报
- WebSocket — 实时数据传输

## 📂 项目结构

```
Web/
├── index.html          # 入口 HTML
├── main.js             # 主逻辑（模型加载、骨骼控制、渲染循环）
├── serial.js           # 串口/蓝牙通信、5种格式数据解析、校准面板
├── websocket_client.js # WebSocket 客户端、检测结果展示
├── voice.js            # 语音播报模块（右下角开关按钮）
├── labels.js           # 标签映射表（英文 → 中文翻译）
├── style.css           # 全局 UI 样式
├── package.json        # 项目配置（Vite + Three.js + GSAP + Tweakpane）
├── temp_patch.txt      # 临时补丁记录
├── public/             # 静态资源（GLB 模型等）
└── device/
    └── right/
        └── right.ino   # 右手设备固件（ESP-NOW 主机 + BLE 透传）
```

## 📄 License

MIT
