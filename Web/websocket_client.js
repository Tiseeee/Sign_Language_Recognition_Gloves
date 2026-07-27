// websocket_client.js
// 双向 WebSocket 通信：发送手势特征 → 接收 CNN 识别结果
import { translateLabel } from './labels.js';
import './voice.js';  // 纯副作用：挂载 window.speakVoice 并创建按钮

let ws = null;
let reconnectTimer = null;
let isConnected = false;

// 最近一次识别结果缓存（用于去重，避免重复语音播报）
let lastLabel = null;
let lastLabelTime = 0;
const LABEL_COOLDOWN_MS = 2000;  // 同一标签语音播报冷却时间

// WebSocket & API URL 自动检测
const WS_PORT = 8765;
const WS_URL = `ws://${window.location.hostname}:${WS_PORT}`;

// ============================================================
//  检测结果浮动面板（顶部居中）
// ============================================================

function ensurePanel() {
    let panel = document.getElementById('detection-panel');
    if (!panel) {
        panel = document.createElement('div');
        panel.id = 'detection-panel';
        panel.style.cssText = `
            position: fixed;
            top: 10px;
            left: 50%;
            transform: translateX(-50%);
            max-width: 420px;
            min-width: 240px;
            color: #fff;
            padding: 14px 18px;
            border-radius: 10px;
            font-family: 'IBM Plex Mono', monospace;
            font-size: 13px;
            z-index: 1000;
            background: rgba(0,0,0,0.78);
            backdrop-filter: blur(8px);
            box-shadow: 0 4px 20px rgba(0,0,0,0.5);
            max-height: 160px;
            overflow-y: auto;
            pointer-events: none;
            transition: background 0.3s, box-shadow 0.3s;
            text-align: center;
        `;
        panel.innerHTML = '<div style="color:#888;">🔗 正在连接识别服务...</div>';
        document.body.appendChild(panel);
    }
    return panel;
}



// ============================================================
//  发送函数
// ============================================================

export function sendFeatures(features) {
    if (!isConnected || !ws || ws.readyState !== WebSocket.OPEN) return;
    if (!Array.isArray(features) || features.length !== 12) return;
    try {
        ws.send(JSON.stringify({ features }));
    } catch (e) {
        console.warn('发送特征失败:', e);
    }
}

export function sendHandData(leftData, rightData) {
    if (!isConnected || !ws || ws.readyState !== WebSocket.OPEN) return;
    try {
        ws.send(JSON.stringify({ left: leftData || {}, right: rightData || {} }));
    } catch (e) {
        console.warn('发送手势数据失败:', e);
    }
}

// ============================================================
//  WebSocket 连接
// ============================================================

export function initWebSocket() {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    ws = new WebSocket(WS_URL);
    const panel = ensurePanel();

    ws.onopen = () => {
        console.log(`🔗 WebSocket 已连接: ${WS_URL}`);
        isConnected = true;
        panel.innerHTML = '<div style="color:#8f8;">✅ 手势识别服务已连接</div>';
        panel.style.background = 'rgba(0,0,0,0.78)';
    };

    ws.onmessage = (event) => {
        if (window.serialCalibrating) return;
        try {
            const data = JSON.parse(event.data);

            // info 消息
            if (data.type === 'info') {
                console.log('ℹ️', data.message);
                panel.innerHTML = `<div style="color:#f39c12;">ℹ️ ${data.message}</div>`;
                panel.style.background = 'rgba(0,0,0,0.78)';
                panel.style.boxShadow = '0 4px 20px rgba(0,0,0,0.5), 0 0 0 2px #f39c12';
                return;
            }
            // error
            if (data.type === 'error') {
                console.warn('⚠️', data.message);
                panel.innerHTML = `<div style="color:#e74c3c;">⚠️ ${data.message}</div>`;
                return;
            }

            // prediction
            if (data.type === 'prediction' || data.name_cn !== undefined) {
                const label = data.label;
                const name = data.name_cn || data.name || '未知';
                const confidence = data.confidence || 0;
                const confPct = (confidence * 100).toFixed(1);

                let bgColor, borderColor, emoji;
                if (label >= 0 && confidence >= 0.5) {
                    bgColor = 'rgba(107,106,179,0.85)';
                    borderColor = '#6B6AB3';
                    emoji = '🤟';
                } else if (label >= 0) {
                    bgColor = 'rgba(243,156,18,0.85)';
                    borderColor = '#f39c12';
                    emoji = '🤔';
                } else {
                    bgColor = 'rgba(0,0,0,0.78)';
                    borderColor = '#555';
                    emoji = '❓';
                }

                panel.style.background = bgColor;
                panel.style.boxShadow = `0 4px 20px rgba(0,0,0,0.5), 0 0 0 2px ${borderColor}`;

                let html = `<div style="font-size:24px;font-weight:bold;margin-bottom:4px;">${emoji} ${name}</div>`;
                html += `<div style="font-size:14px;color:#ddd;">置信度: <strong>${confPct}%</strong></div>`;

                if (data.all_probs) {
                    html += '<div style="margin-top:6px;font-size:10px;color:#aaa;display:flex;flex-wrap:wrap;gap:4px;justify-content:center;">';
                    for (const [gName, prob] of Object.entries(data.all_probs)) {
                        const p = (prob * 100).toFixed(1);
                        html += `<span style="${prob === confidence ? 'color:#fff;font-weight:bold;' : ''}">${translateLabel(gName)}:${p}%</span>`;
                    }
                    html += '</div>';
                }
                panel.innerHTML = html;

                if (label >= 0 && confidence >= 0.5 && window.speakVoice) {
                    const now = Date.now();
                    if (name !== lastLabel || (now - lastLabelTime) > LABEL_COOLDOWN_MS) {
                        lastLabel = name;
                        lastLabelTime = now;
                        window.speakVoice(name, confidence);
                    }
                }
            }
        } catch (e) {
            console.warn('解析 WebSocket 消息失败:', e);
        }
    };

    ws.onerror = () => {
        isConnected = false;
        if (!window.serialCalibrating) {
            panel.innerHTML = '<div style="color:#e74c3c;">❌ 连接失败，请先启动识别服务</div>';
            panel.style.background = 'rgba(0,0,0,0.78)';
        }
    };

    ws.onclose = () => {
        isConnected = false;
        if (!window.serialCalibrating) {
            panel.innerHTML = '<div style="color:#e74c3c;">⚠️ 已断开，5秒后重连...</div>';
            panel.style.background = 'rgba(0,0,0,0.78)';
        }
        reconnectTimer = setTimeout(() => initWebSocket(), 5000);
    };

    // 暴露到全局
    window.sendFeatures = sendFeatures;
    window.sendHandData = sendHandData;
    window.setDetectionPanel = (html) => { panel.innerHTML = html; };
    window.appendDetectionPanel = (html) => { panel.innerHTML += html; };
    window.getDetectionPanel = () => panel;
}