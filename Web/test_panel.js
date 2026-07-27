// ============================================================
// test_panel.js - 模拟测试面板（无需蓝牙即可测试 + 训练）
// ============================================================

const FINGER_NAMES = ['拇指', '食指', '中指', '无名指', '小指', '手腕'];

const gestureHistory = [];
let currentGesture = '';
let currentGestureEn = '';

async function apiPost(path, data) {
    try {
        const resp = await fetch(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
        });
        const text = await resp.text();
        try {
            return JSON.parse(text);
        } catch {
            return { ok: false, error: `服务返回非JSON: ${text.slice(0, 200)}` };
        }
    } catch (e) {
        console.error(`API ${path} 失败:`, e);
        return { ok: false, error: String(e) };
    }
}

async function apiGet(path) {
    try {
        const resp = await fetch(path);
        const text = await resp.text();
        try {
            return JSON.parse(text);
        } catch {
            return { ok: false, error: `服务返回非JSON: ${text.slice(0, 200)}` };
        }
    } catch (e) {
        console.error(`API ${path} 失败:`, e);
        return null;
    }
}

function setStatus(msg, color = '#8f8') {
    const status = document.getElementById('test-status');
    if (status) {
        status.innerHTML = msg;
        status.style.color = color;
    }
}

function updateHistoryCount() {
    const el = document.getElementById('history-count');
    if (el) el.textContent = '历史: ' + gestureHistory.length + ' 个手势';
}

function addToHistory(gestureCn, gestureEn) {
    if (!gestureCn) return;
    if (gestureHistory.length === 0 || gestureHistory[gestureHistory.length - 1] !== gestureCn) {
        gestureHistory.push(gestureCn);
        if (gestureHistory.length > 20) gestureHistory.shift();
        updateHistoryCount();
    }
    currentGesture = gestureCn;
    currentGestureEn = gestureEn || gestureCn;
}

function showAiResult(html) {
    const el = document.getElementById('ai-result');
    if (el) {
        el.innerHTML = html;
        el.style.display = 'block';
    }
}

function applyHandsFromFeatures(features) {
    if (window.PARAMS && window.RIGHT_PARAMS) {
        window.PARAMS.thumb = features[0];
        window.PARAMS.index = features[1];
        window.PARAMS.middle = features[2];
        window.PARAMS.ring = features[3];
        window.PARAMS.pinky = features[4];
        window.PARAMS.wrist = features[5];
        window.RIGHT_PARAMS.thumb = features[6];
        window.RIGHT_PARAMS.index = features[7];
        window.RIGHT_PARAMS.middle = features[8];
        window.RIGHT_PARAMS.ring = features[9];
        window.RIGHT_PARAMS.pinky = features[10];
        window.RIGHT_PARAMS.wrist = features[11];
    }
    if (typeof window.leftBonesSync === 'function') {
        window.leftBonesSync();
    } else {
        let tries = 0;
        const trySync = setInterval(() => {
            tries++;
            if (typeof window.leftBonesSync === 'function') {
                window.leftBonesSync();
                clearInterval(trySync);
            }
            if (tries > 50) clearInterval(trySync);
        }, 100);
    }
    if (typeof window.rightBonesSync === 'function') {
        window.rightBonesSync();
    } else {
        let tries = 0;
        const trySync = setInterval(() => {
            tries++;
            if (typeof window.rightBonesSync === 'function') {
                window.rightBonesSync();
                clearInterval(trySync);
            }
            if (tries > 50) clearInterval(trySync);
        }, 100);
    }
}

function createTestPanel() {
    if (document.getElementById('test-panel')) return;

    const panel = document.createElement('div');
    panel.id = 'test-panel';
    panel.style.cssText = `
        position: fixed;
        bottom: 20px;
        right: 20px;
        background: rgba(0,0,0,0.88);
        backdrop-filter: blur(10px);
        color: #fff;
        padding: 16px;
        border-radius: 12px;
        font-family: 'IBM Plex Mono', monospace;
        font-size: 12px;
        z-index: 1000;
        max-width: 360px;
        max-height: 80vh;
        overflow-y: auto;
        box-shadow: 0 8px 24px rgba(0,0,0,0.6);
        border: 1px solid rgba(255,255,255,0.1);
    `;

    panel.innerHTML = `
        <div style="font-size:15px;font-weight:bold;margin-bottom:4px;color:#8f8;">
            🧪 模拟测试 & 训练面板
        </div>
        <div id="test-status" style="font-size:11px;color:#aaa;margin-bottom:10px;">
            无需蓝牙，可直接模拟/采集/训练
        </div>

        <!-- 左手输入 -->
        <div style="margin-bottom:8px;">
            <div style="font-size:11px;font-weight:bold;color:#ddd;margin-bottom:4px;">左手 (6维, 0=弯曲 1=伸直)</div>
            <div id="left-inputs" style="display:grid;grid-template-columns:repeat(3,1fr);gap:4px;"></div>
        </div>

        <!-- 右手输入 -->
        <div style="margin-bottom:8px;">
            <div style="font-size:11px;font-weight:bold;color:#ddd;margin-bottom:4px;">右手 (6维, 0=弯曲 1=伸直)</div>
            <div id="right-inputs" style="display:grid;grid-template-columns:repeat(3,1fr);gap:4px;"></div>
        </div>

        <!-- 标签输入 -->
        <div style="margin-bottom:10px;">
            <div style="font-size:11px;font-weight:bold;color:#ddd;margin-bottom:4px;">标签文字</div>
            <div style="display:flex;gap:6px;">
                <input id="label-en" type="text" placeholder="英文(如 ok_gesture)" value=""
                    style="flex:1;padding:6px;font-size:11px;background:rgba(255,255,255,0.1);
                    border:1px solid #555;border-radius:4px;color:#fff;font-family:inherit;">
                <input id="label-cn" type="text" placeholder="中文(如 OK手势)" value=""
                    style="flex:1;padding:6px;font-size:11px;background:rgba(255,255,255,0.1);
                    border:1px solid #555;border-radius:4px;color:#fff;font-family:inherit;">
            </div>
        </div>

        <!-- 操作按钮 -->
        <div style="display:flex;flex-direction:column;gap:6px;">
            <button id="btn-collect" style="
                padding:10px;font-size:13px;font-weight:bold;
                background:rgba(46,204,113,0.3);border:1px solid #2ecc71;
                color:#fff;border-radius:6px;cursor:pointer;font-family:inherit;
            ">📥 采集样本 (保存到训练集)</button>

            <div style="display:flex;gap:6px;">
                <input id="collect-count" type="number" value="10" min="1" max="100"
                    style="width:60px;padding:6px;font-size:11px;background:rgba(255,255,255,0.1);
                    border:1px solid #555;border-radius:4px;color:#fff;font-family:inherit;text-align:center;">
                <span style="font-size:10px;color:#aaa;line-height:28px;">采集次数（每次加噪声）</span>
            </div>

            <button id="btn-train" style="
                padding:10px;font-size:13px;font-weight:bold;
                background:rgba(243,156,18,0.3);border:1px solid #f39c12;
                color:#fff;border-radius:6px;cursor:pointer;font-family:inherit;
            ">🔥 开始训练</button>

            <button id="btn-send" style="
                padding:10px;font-size:13px;font-weight:bold;
                background:rgba(52,152,219,0.3);border:1px solid #3498db;
                color:#fff;border-radius:6px;cursor:pointer;font-family:inherit;
            ">📤 发送手势 (识别)</button>

            <div style="display:flex;gap:6px;">
                <button id="btn-clear" style="
                    flex:1;padding:8px;font-size:11px;
                    background:rgba(231,76,60,0.2);border:1px solid #e74c3c;
                    color:#fff;border-radius:6px;cursor:pointer;font-family:inherit;
                ">🗑️ 清空数据</button>
                <button id="btn-labels" style="
                    flex:1;padding:8px;font-size:11px;
                    background:rgba(149,165,166,0.2);border:1px solid #95a5a6;
                    color:#fff;border-radius:6px;cursor:pointer;font-family:inherit;
                ">📋 查看标签</button>
            </div>
        </div>

        <!-- AI 智能助手 -->
        <div style="margin-top:12px;padding-top:10px;border-top:1px solid rgba(255,255,255,0.15);">
            <div style="font-size:12px;font-weight:bold;color:#a855f7;margin-bottom:6px;">🤖 AI 智能助手</div>
            <div style="display:flex;gap:6px;margin-bottom:8px;">
                <button id="btn-explain" style="
                    flex:1;padding:7px;font-size:11px;font-weight:bold;
                    background:rgba(168,85,247,0.2);border:1px solid #a855f7;
                    color:#fff;border-radius:6px;cursor:pointer;font-family:inherit;
                ">💡 解释手势</button>
                <button id="btn-predict" style="
                    flex:1;padding:7px;font-size:11px;font-weight:bold;
                    background:rgba(168,85,247,0.2);border:1px solid #a855f7;
                    color:#fff;border-radius:6px;cursor:pointer;font-family:inherit;
                ">🔮 预测下一句</button>
            </div>
            <div id="ai-result" style="
                font-size:11px;color:#ccc;background:rgba(168,85,247,0.08);
                border:1px solid rgba(168,85,247,0.2);border-radius:6px;
                padding:8px;max-height:200px;overflow-y:auto;line-height:1.5;display:none;
            "></div>
            <div style="display:flex;gap:6px;margin-top:6px;">
                <button id="btn-clear-history" style="
                    flex:1;padding:5px;font-size:10px;
                    background:rgba(107,114,128,0.2);border:1px solid #6b7280;
                    color:#9ca3af;border-radius:4px;cursor:pointer;font-family:inherit;
                ">清除历史</button>
                <span id="history-count" style="font-size:10px;color:#666;align-self:center;">历史: 0 个手势</span>
            </div>
        </div>
    `;

    document.body.appendChild(panel);

    const defaultLeft = [0, 0, 0, 0, 0, 0];
    const defaultRight = [0, 0, 0, 0, 0, 0];

    function createHandInputs(containerId, values) {
        const container = document.getElementById(containerId);
        FINGER_NAMES.forEach((name, i) => {
            const wrapper = document.createElement('div');
            wrapper.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:2px;';
            wrapper.innerHTML = `
                <span style="font-size:9px;color:#888;">${name}</span>
                <input type="number" min="0" max="1" step="0.05" value="${values[i]}"
                    data-finger="${i}"
                    style="width:100%;padding:4px;font-size:11px;background:rgba(255,255,255,0.1);
                    border:1px solid #555;border-radius:3px;color:#fff;font-family:inherit;text-align:center;">
            `;
            container.appendChild(wrapper);
        });
    }
    createHandInputs('left-inputs', defaultLeft);
    createHandInputs('right-inputs', defaultRight);

    function getHandValues(containerId) {
        const inputs = document.querySelectorAll(`#${containerId} input`);
        return Array.from(inputs).map(inp => parseFloat(inp.value) || 0);
    }

    // ===== 采集样本 =====
    document.getElementById('btn-collect').addEventListener('click', async () => {
        const left = getHandValues('left-inputs');
        const right = getHandValues('right-inputs');
        const labelEn = document.getElementById('label-en').value.trim();
        const labelCn = document.getElementById('label-cn').value.trim() || labelEn;
        const count = parseInt(document.getElementById('collect-count').value) || 1;

        if (!labelEn) {
            setStatus('❌ 请输入英文标签名', '#e74c3c');
            return;
        }

        const btn = document.getElementById('btn-collect');
        btn.textContent = '⏳ 采集中...';
        btn.disabled = true;

        let success = 0;
        for (let i = 0; i < count; i++) {
            const noisyLeft = left.map(v => Math.max(0, Math.min(1, v + (Math.random() - 0.5) * 0.1)));
            const noisyRight = right.map(v => Math.max(0, Math.min(1, v + (Math.random() - 0.5) * 0.1)));

            const result = await apiPost('/api/collect_sample', {
                left: {
                    thumb: noisyLeft[0], index: noisyLeft[1], middle: noisyLeft[2],
                    ring: noisyLeft[3], pinky: noisyLeft[4], wrist: noisyLeft[5],
                },
                right: {
                    thumb: noisyRight[0], index: noisyRight[1], middle: noisyRight[2],
                    ring: noisyRight[3], pinky: noisyRight[4], wrist: noisyRight[5],
                },
                label_name_en: labelEn,
                label_name_cn: labelCn,
            });
            if (result.ok) success++;
        }

        btn.textContent = '📥 采集样本 (保存到训练集)';
        btn.disabled = false;
        setStatus(`✅ 采集 ${success}/${count} 个样本 → ${labelCn}`, '#2ecc71');
    });

    // ===== 开始训练 =====
    document.getElementById('btn-train').addEventListener('click', async () => {
        const btn = document.getElementById('btn-train');
        btn.textContent = '⏳ 训练中...';
        btn.disabled = true;
        setStatus('🔥 训练已启动，请等待...', '#f39c12');

        const result = await apiPost('/api/train', {});
        if (!result.ok) {
            setStatus(`❌ ${result.error}`, '#e74c3c');
            btn.textContent = '🔥 开始训练';
            btn.disabled = false;
            return;
        }

        const poll = setInterval(async () => {
            const status = await apiGet('/api/train_status');
            if (!status || !status.training) {
                clearInterval(poll);
                btn.textContent = '🔥 开始训练';
                btn.disabled = false;
                setStatus(status ? status.message : '训练完成',
                         status && status.message && status.message.includes('失败') ? '#e74c3c' : '#2ecc71');
            } else {
                setStatus(`⏳ ${status.message}`, '#f39c12');
            }
        }, 2000);
    });

    // ===== 发送手势（识别）=====
    document.getElementById('btn-send').addEventListener('click', () => {
        const left = getHandValues('left-inputs');
        const right = getHandValues('right-inputs');
        setStatus('📤 发送手势数据 (1秒)...', '#3498db');
        
        const interval = 20;
        const count = Math.floor(1000 / interval);
        let sent = 0;
        const timer = setInterval(() => {
            const noisyLeft = left.map(v => Math.max(0, Math.min(1, v + (Math.random() - 0.5) * 0.05)));
            const noisyRight = right.map(v => Math.max(0, Math.min(1, v + (Math.random() - 0.5) * 0.05)));
            const features = [...noisyLeft, ...noisyRight];
            if (window.sendFeatures) {
                window.sendFeatures(features);
            }
            applyHandsFromFeatures(features);
            sent++;
            if (sent >= count) {
                clearInterval(timer);
                setStatus('✅ 已发送，查看顶部识别结果', '#8f8');
            }
        }, interval);
    });

    // ===== 清空数据 =====
    document.getElementById('btn-clear').addEventListener('click', async () => {
        if (!confirm('确定清空所有训练数据？')) return;
        const result = await apiPost('/api/clear_samples', {});
        setStatus(result.ok ? '🗑️ 训练数据已清空' : `❌ ${result.error}`,
                  result.ok ? '#8f8' : '#e74c3c');
    });

    // ===== 查看标签 =====
    document.getElementById('btn-labels').addEventListener('click', async () => {
        const result = await apiGet('/api/labels');
        if (result && result.labels) {
            const labelsStr = result.labels.map(l => `${l.id}:${l.name_cn}(${l.name_en})`).join(', ');
            setStatus(`📋 ${result.count} 个标签: ${labelsStr}`, '#8f8');
        }
    });

    // ===== 解释手势 =====
    document.getElementById('btn-explain').addEventListener('click', async () => {
        const gesture = currentGesture || document.getElementById('label-cn').value.trim() || document.getElementById('label-en').value.trim();
        const gestureEn = currentGestureEn || document.getElementById('label-en').value.trim();
        if (!gesture) {
            setStatus('❌ 请先识别或输入一个手势', '#e74c3c');
            return;
        }
        const btn = document.getElementById('btn-explain');
        btn.disabled = true;
        btn.textContent = '⏳ 分析中...';
        showAiResult('<div style="color:#a855f7;">🤖 AI 正在分析手势「' + gesture + '」...</div>');
        
        const r = await apiPost('/api/explain_gesture', {
            gesture_cn: gesture,
            gesture_en: gestureEn
        });
        
        btn.disabled = false;
        btn.textContent = '💡 解释手势';
        
        if (r.ok && r.data) {
            const d = r.data;
            function toHtml(val) {
                if (Array.isArray(val)) {
                    return '<ul style="margin:4px 0;padding-left:18px;">' + val.map(v => '<li>' + v + '</li>').join('') + '</ul>';
                }
                if (typeof val === 'object' && val !== null) {
                    let s = '<div style="margin:4px 0;">';
                    for (const [k, v] of Object.entries(val)) {
                        const label = k === 'positive' ? '正面含义' : k === 'negative' ? '负面/冒犯' : k === 'other' ? '其他文化' : k;
                        const color = k === 'positive' ? '#2ecc71' : k === 'negative' ? '#e74c3c' : '#f39c12';
                        s += '<div style="margin-bottom:4px;"><b style="color:' + color + ';">' + label + '：</b>' + v + '</div>';
                    }
                    s += '</div>';
                    return s;
                }
                return String(val || '-');
            }
            showAiResult(
                '<div style="color:#a855f7;font-weight:bold;margin-bottom:8px;font-size:13px;">📖 「' + gesture + '」手势详解</div>' +
                '<div style="margin-bottom:8px;"><b style="color:#8f8;">📌 标准含义</b>' + toHtml(d.meaning) + '</div>' +
                '<div style="margin-bottom:8px;"><b style="color:#f39c12;">🌍 文化背景差异</b>' + toHtml(d.culture) + '</div>' +
                '<div style="margin-bottom:8px;"><b style="color:#3498db;">✋ 变体形式</b>' + toHtml(d.variants) + '</div>' +
                '<div><b style="color:#e879f9;">💬 使用场景</b>' + toHtml(d.usage) + '</div>'
            );
        } else {
            showAiResult('<div style="color:#e74c3c;">❌ ' + (r.error || '分析失败') + '</div>');
        }
    });

    // ===== 预测下一句 =====
    document.getElementById('btn-predict').addEventListener('click', async () => {
        if (gestureHistory.length === 0) {
            setStatus('❌ 请先识别一些手势以建立历史', '#e74c3c');
            return;
        }
        const btn = document.getElementById('btn-predict');
        btn.disabled = true;
        btn.textContent = '⏳ 预测中...';
        showAiResult('<div style="color:#a855f7;">🔮 AI 正在预测下一句...</div><div style="color:#888;margin-top:4px;font-size:10px;">已识别手势: ' + gestureHistory.join(' → ') + '</div>');
        
        const r = await apiPost('/api/predict_next', {
            gesture_history: gestureHistory,
            context: ''
        });
        
        btn.disabled = false;
        btn.textContent = '🔮 预测下一句';
        
        if (r.ok && r.data) {
            showAiResult(
                '<div style="color:#a855f7;font-weight:bold;margin-bottom:6px;">🔮 下一句预测</div>' +
                '<div style="color:#888;font-size:10px;margin-bottom:6px;">手势序列: ' + gestureHistory.join(' → ') + '</div>' +
                '<div style="background:rgba(168,85,247,0.15);padding:8px;border-radius:4px;border-left:3px solid #a855f7;">💬 ' + r.data + '</div>'
            );
        } else {
            showAiResult('<div style="color:#e74c3c;">❌ ' + (r.error || '预测失败') + '</div>');
        }
    });

    // ===== 清除历史 =====
    document.getElementById('btn-clear-history').addEventListener('click', () => {
        gestureHistory.length = 0;
        currentGesture = '';
        currentGestureEn = '';
        updateHistoryCount();
        const el = document.getElementById('ai-result');
        if (el) {
            el.innerHTML = '';
            el.style.display = 'none';
        }
        setStatus('🧹 手势历史已清除', '#8f8');
    });

    // ===== 监听顶部识别面板变化，记录手势历史 =====
    function observeDetectionPanel() {
        const panel = document.getElementById('detection-panel');
        if (!panel) return false;

        const observer = new MutationObserver(function(mutations) {
            for (const mut of mutations) {
                if (mut.type === 'childList' || mut.type === 'characterData') {
                    const text = panel.textContent || '';
                    const confMatch = text.match(/置信度:\s*([\d.]+)%/);
                    const nameMatch = text.match(/[\u4e00-\u9fa5a-zA-Z]+/);
                    if (confMatch && nameMatch) {
                        const conf = parseFloat(confMatch[1]);
                        if (conf >= 50) {
                            const gestureName = nameMatch[0];
                            if (gestureName && gestureName !== '识别' && gestureName !== '正在' && gestureName !== '手势') {
                                addToHistory(gestureName, '');
                            }
                        }
                    }
                }
            }
        });
        observer.observe(panel, { childList: true, characterData: true, subtree: true });
        return true;
    }

    const panelCheckInterval = setInterval(() => {
        if (observeDetectionPanel()) {
            clearInterval(panelCheckInterval);
        }
    }, 1000);
    setTimeout(() => { clearInterval(panelCheckInterval); }, 15000);
}

// 初始化
function initTestPanel() {
    if (document.getElementById('test-panel')) return;
    createTestPanel();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(initTestPanel, 1000));
} else {
    setTimeout(initTestPanel, 1000);
}