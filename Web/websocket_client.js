// websocket_client.js
import { translateLabel } from './labels.js';
import './voice.js';  // 纯副作用：挂载 window.speakVoice 并创建按钮

export function initWebSocket() {
    const ws = new WebSocket('ws://localhost:8765');

    // 创建用于显示检测结果的浮动面板（如果不存在）
    let panel = document.getElementById('detection-panel');
    if (!panel) {
        panel = document.createElement('div');
        panel.id = 'detection-panel';
        panel.style.cssText = `
            position: fixed;
            top: 10px;
            left: 50%;
            transform: translateX(-50%);
            max-width: 400px;
            min-width: 200px;
            color: #fff;
            padding: 12px 16px;
            border-radius: 8px;
            font-family: 'IBM Plex Mono', monospace;
            font-size: 13px;
            z-index: 1000;
            background: rgba(0,0,0,0.75);
            backdrop-filter: blur(6px);
            box-shadow: 0 4px 15px rgba(0,0,0,0.4);
            max-height: 120px;
            overflow-y: auto;
            pointer-events: none;
            transition: background 0.3s, box-shadow 0.3s;
        `;
        panel.innerHTML = '<div style="color:#888;">🔗 正在连接...</div>';
        document.body.appendChild(panel);
    }

    ws.onopen = () => {
        console.log('🔗 WebSocket 已连接');
        panel.innerHTML = '<div style="color:#8f8;">✅ 连接成功</div>';
    };

    ws.onmessage = (event) => {
        // 串口校准期间不更新 WebSocket 检测结果
        if (window.serialCalibrating) return;
        try {
            const data = JSON.parse(event.data);
            if (data.detections) {
                // 更新面板
                let html = `<div style="margin-bottom:8px;color:#aaa;font-size:12px;">📡 检测到 ${data.detections.length} 个目标</div>`;
                data.detections.forEach((d, i) => {
                    const label = translateLabel(d.label);
                    const conf = d.confidence;
                    const bbox = d.bbox.join(', ');
                    html += `<div style="margin:4px 0;border-bottom:1px solid #444;padding-bottom:4px;">
                        <span style="color:#6B6AB3;">${i+1}.</span>
                        <strong>${label}</strong> (${(conf*100).toFixed(1)}%)
                        <span style="color:#888;font-size:11px;">[${bbox}]</span>
                    </div>`;
                });
                panel.innerHTML = html;

                // 语音播报置信度最高的目标
                if (data.detections.length > 0) {
                    const best = data.detections.reduce((a, b) =>
                        a.confidence > b.confidence ? a : b
                    );
                    if (window.speakVoice) {
                        window.speakVoice(translateLabel(best.label), best.confidence);
                    }
                }
            }
        } catch (e) {
            console.warn('解析 JSON 失败:', e);
        }
    };

    ws.onerror = (error) => {
        console.error('WebSocket 错误:', error);
        if (!window.serialCalibrating) {
            panel.innerHTML = '<div style="color:#e74c3c;">❌ 连接错误，请检查 Python 服务</div>';
        }
    };

    ws.onclose = () => {
        console.log('🔌 WebSocket 已断开');
        if (!window.serialCalibrating) {
            panel.innerHTML = '<div style="color:#e74c3c;">⚠️ 已断开连接，尝试重连...</div>';
        }
        // 尝试重连（5秒后）
        setTimeout(() => {
            initWebSocket();
        }, 5000);
    };

    // 暴露面板控制供串口模块使用
    window.setDetectionPanel = (html) => { panel.innerHTML = html; };
    window.appendDetectionPanel = (html) => { panel.innerHTML += html; };
    window.getDetectionPanel = () => panel;
}