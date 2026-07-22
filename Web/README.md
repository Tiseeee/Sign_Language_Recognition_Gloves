# 🖐️ 手部姿态模拟器

基于 Three.js 的 3D 手部骨骼姿态模拟器，支持串口硬件数据输入与 WebSocket 实时检测结果展示。

## ✨ 功能特性

- **3D 手部模型** — 加载 GLB 格式的左手/右手骨骼模型，支持五指独立屈伸控制
- **串口通信** — 通过 Web Serial API 接收硬件手指数据，实时驱动 3D 手部骨骼动画
- **校准模式** — 串口连接后自动进入校准，逐行显示设备校准数据，校准完成后自动关闭面板
- **WebSocket 识别** — 连接 Python 后端服务，实时显示目标检测结果
- **手动控制面板** — 使用 Tweakpane 独立调节每根手指的弯曲角度、手腕旋转
- **颜色自定义** — 调节手部、衬衫、背心的颜色
- **右手镜像** — 左手动作自动同步到右手模型

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

## 🔌 串口连接

1. 点击底部工具栏的 **🔌 连接串口** 按钮
2. 在弹出窗口中选择对应的串口设备
3. 连接后自动进入校准模式，面板会显示设备传来的校准数据
4. 收到有效手指数据后校准完成，面板自动消失
5. 可通过频率下拉菜单调整采样频率

### 串口数据格式

支持以下三种格式：

| 格式 | 示例 |
|------|------|
| JSON | `{"thumb":0.25,"index":0.50,"middle":0.80,"ring":0.30,"pinky":0.10}` |
| 标签 | `thumb:0.25,index:0.50,middle:0.80,ring:0.30,pinky:0.10` |
| CSV | `0.25,0.50,0.80,0.30,0.10` |

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
- Web Serial API — 串口通信
- WebSocket — 实时数据传输

## 📂 项目结构

```
├── index.html          # 入口 HTML
├── main.js             # 主逻辑（模型加载、骨骼控制、渲染循环）
├── serial.js           # 串口通信、数据解析、校准面板
├── websocket_client.js # WebSocket 客户端、检测结果展示
├── style.css           # 全局样式
├── package.json        # 项目配置
├── hand.glb            # 左手 3D 模型
├── righthand.glb       # 右手 3D 模型
└── public/             # 静态资源
```

## 📄 License

MIT
