// websocket_client.js
import { translateLabel } from './labels.js';

export function initWebSocket() {
    const ws = new WebSocket('ws://localhost:8765');

    // 创建用于显示检测结果的浮动面板（如果不存在）
    let panel = document.getElementById('detection-panel');
    if (!panel) {
        panel = document.createElement('div');
        panel.id = 'detection-panel';
        panel.style.cssText = `
            position: fixed;
            top: 80px;
            right: 20px;
            max-width: 300px;
            background: rgba(0,0,0,0.75);
            color: #fff;
            padding: 12px 16px;
            border-radius: 8px;
            font-family: 'IBM Plex Mono', monospace;
            font-size: 13px;
            z-index: 1000;
            backdrop-filter: blur(6px);
            max-height: 80vh;
            overflow-y: auto;
            pointer-events: none;
            box-shadow: 0 4px 15px rgba(0,0,0,0.4);
        `;
        document.body.appendChild(panel);
    }

    ws.onopen = () => {
        console.log('🔗 WebSocket 已连接');
        panel.innerHTML = '<div style="color:#8f8;">✅ 连接成功</div>';
    };

    ws.onmessage = (event) => {
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
            }
        } catch (e) {
            console.warn('解析 JSON 失败:', e);
        }
    };

    ws.onerror = (error) => {
        console.error('WebSocket 错误:', error);
        panel.innerHTML = '<div style="color:#e74c3c;">❌ 连接错误，请检查 Python 服务</div>';
    };

    ws.onclose = () => {
        console.log('🔌 WebSocket 已断开');
        panel.innerHTML = '<div style="color:#e74c3c;">⚠️ 已断开连接，尝试重连...</div>';
        // 尝试重连（5秒后）
        setTimeout(() => {
            initWebSocket();
        }, 5000);
    };
}