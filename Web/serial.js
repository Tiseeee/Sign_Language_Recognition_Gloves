// ============================================================
// serial.js - 串口通信 + 采样频率控制
// ============================================================
function simulateFingerData(t, i, m, r, p) {
    const data = { thumb: t, index: i, middle: m, ring: r, pinky: p };
    // 直接调用内部处理函数
    fingerSerial._processLine(JSON.stringify(data));
}

class SerialFingerController {
    constructor() {
        this.port = null;
        this.reader = null;
        this.isConnected = false;
        this.buffer = '';
        this.onFingerData = null;

        this.FINGER_KEYS = ['thumb', 'index', 'middle', 'ring', 'pinky'];
        this.FINGER_MAX = {
            thumb: 0.9,
            index: 1.1,
            middle: 1.25,
            ring: 1.25,
            pinky: 1.15,
        };

        // ---------- 采样频率指令格式（可自定义） ----------
        // 函数参数：频率值（数字），返回要发送的字符串
        this.frequencyCommandFormat = (freq) => `FREQ:${freq}`;
    }

    async connect(baudRate = 115200) {
        if (!('serial' in navigator)) {
            alert('❌ 当前浏览器不支持 Web Serial API，请使用 Chrome 或 Edge。');
            return false;
        }
        try {
            this.port = await navigator.serial.requestPort();
            await this.port.open({ baudRate, dataBits: 8, stopBits: 1, parity: 'none' });
            this.isConnected = true;
            console.log(`✅ 串口已连接 (${baudRate} bps)`);
            this._startReading();
            return true;
        } catch (e) {
            console.error('❌ 连接失败:', e);
            alert('串口连接失败: ' + e.message);
            return false;
        }
    }

    async disconnect() {
        if (this.reader) {
            try { await this.reader.cancel(); } catch (e) {}
            this.reader = null;
        }
        if (this.port) {
            try { await this.port.close(); } catch (e) {}
            this.port = null;
        }
        this.isConnected = false;
        console.log('🔌 串口已断开');
    }

    onData(callback) {
        this.onFingerData = callback;
    }

    // ---------- 发送数据 ----------
    async send(data) {
        if (!this.isConnected) {
            console.warn('⚠️ 串口未连接，无法发送');
            return false;
        }
        try {
            const writer = this.port.writable.getWriter();
            const encoder = new TextEncoder();
            await writer.write(encoder.encode(data + '\n'));
            writer.releaseLock();
            console.log(`📤 已发送: ${data}`);
            return true;
        } catch (e) {
            console.warn('发送失败:', e);
            return false;
        }
    }

    // ---------- 设置采样频率 ----------
    async setSamplingFrequency(freq) {
        const cmd = this.frequencyCommandFormat(freq);
        const ok = await this.send(cmd);
        if (ok) {
            console.log(`📶 采样频率已设置为 ${freq} Hz`);
        }
        return ok;
    }

    // ---------- 内部解析 ----------
    async _startReading() {
        try {
            const reader = this.port.readable.getReader();
            this.reader = reader;
            const decoder = new TextDecoder();
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                this.buffer += decoder.decode(value, { stream: true });
                const lines = this.buffer.split('\n');
                this.buffer = lines.pop() || '';
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (trimmed) this._processLine(trimmed);
                }
            }
        } catch (e) {
            if (e.name !== 'AbortError') console.error('读取错误:', e);
        } finally {
            this.isConnected = false;
        }
    }

    _processLine(line) {
        // 1) JSON
        if (line.startsWith('{') && line.endsWith('}')) {
            try {
                const obj = JSON.parse(line);
                const result = {};
                let ok = true;
                for (const key of this.FINGER_KEYS) {
                    if (typeof obj[key] === 'number') result[key] = obj[key];
                    else { ok = false; break; }
                }
                if (ok) { this._updateFingers(result); return; }
            } catch (e) {}
        }

        // 2) 标签格式 "thumb:0.25,index:0.50,..."
        if (line.includes(':')) {
            const parts = line.split(',').map(s => s.trim());
            const result = {};
            let ok = true;
            for (const part of parts) {
                const [k, v] = part.split(':').map(s => s.trim());
                if (this.FINGER_KEYS.includes(k)) {
                    const num = parseFloat(v);
                    if (!isNaN(num)) result[k] = num;
                    else { ok = false; break; }
                }
            }
            if (ok && Object.keys(result).length === this.FINGER_KEYS.length) {
                this._updateFingers(result);
                return;
            }
        }

        // 3) 纯 CSV "0.25,0.50,0.80,0.30,0.10"
        const parts = line.split(',').map(s => s.trim());
        if (parts.length >= this.FINGER_KEYS.length) {
            const nums = parts.slice(0, 5).map(Number);
            if (nums.every(n => !isNaN(n))) {
                const result = {};
                for (let i = 0; i < 5; i++) result[this.FINGER_KEYS[i]] = nums[i];
                this._updateFingers(result);
                return;
            }
        }

        console.warn('⚠️ 无法解析串口数据:', line);
    }

    _updateFingers(fingerData) {
        const mapped = {};
        for (const key of this.FINGER_KEYS) {
            const raw = fingerData[key];
            const maxVal = this.FINGER_MAX[key];
            if (raw >= 0 && raw <= 1) {
                mapped[key] = Math.min(maxVal, Math.max(0, raw * maxVal));
            } else {
                mapped[key] = Math.min(maxVal, Math.max(0, raw));
            }
        }

        if (window.Re) {
            for (const key of this.FINGER_KEYS) {
                window.Re[key] = mapped[key];
            }
            if (window.Vi) window.Vi.refresh();
            this._updateBones(mapped);
        }

        console.log('🖐️ 手指值:', Object.entries(mapped)
            .map(([k, v]) => `${k}:${v.toFixed(3)}`).join(' '));

        if (this.onFingerData) this.onFingerData(mapped);
    }

    _updateBones(fingerData) {
        const hand = window.We?.getObjectByName?.('Hand');
        if (hand && hand.skeleton) {
            const bones = hand.skeleton.bones;
            if (bones) {
                const boneMap = {
                    thumb: [3, 4, 5],
                    index: [7, 8, 9],
                    middle: [11, 12, 13],
                    ring: [15, 16, 17],
                    pinky: [19, 20, 21],
                };
                for (const [key, indices] of Object.entries(boneMap)) {
                    const val = fingerData[key] || 0;
                    for (const idx of indices) {
                        if (bones[idx]) bones[idx].rotation.x = val;
                    }
                }
            }
        }

        const rightHand = window.We?.getObjectByName?.('RightHand');
        if (rightHand && rightHand.skeleton) {
            const rightBones = rightHand.skeleton.bones;
            if (rightBones) {
                const boneMap = {
                    thumb: [3, 4, 5],
                    index: [7, 8, 9],
                    middle: [11, 12, 13],
                    ring: [15, 16, 17],
                    pinky: [19, 20, 21],
                };
                for (const [key, indices] of Object.entries(boneMap)) {
                    const val = fingerData[key] || 0;
                    for (const idx of indices) {
                        if (rightBones[idx]) rightBones[idx].rotation.x = val;
                    }
                }
            }
        }

        if (window.rightHandController) {
            window.rightHandController.syncWithLeft();
        }
    }
}

// ============================================================
// 创建实例并暴露全局
// ============================================================
const fingerSerial = new SerialFingerController();
window.fingerSerial = fingerSerial;

// ============================================================
// UI 控制面板（含频率选择）
// ============================================================
function createSerialUI() {
    const container = document.createElement('div');
    container.style.cssText = `
    position: fixed;
    bottom: 60px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 1000;
    display: flex;
    gap: 12px;
    align-items: center;
    background: rgba(0,0,0,0.7);
    padding: 10px 20px;
    border-radius: 12px;
    backdrop-filter: blur(8px);
    font-family: 'IBM Plex Mono', monospace;
    font-size: 13px;
    color: #fff;
    flex-wrap: wrap;
    justify-content: center;
  `;

    // 连接按钮
    const connectBtn = document.createElement('button');
    connectBtn.textContent = '🔌 连接串口';
    connectBtn.style.cssText = `
    padding: 6px 16px;
    border: 1px solid #6B6AB3;
    border-radius: 6px;
    background: #6B6AB3;
    color: #fff;
    cursor: pointer;
    font-family: inherit;
    font-size: 13px;
    transition: all 0.2s;
  `;
    connectBtn.onmouseover = () => connectBtn.style.background = '#7B7AC3';
    connectBtn.onmouseout = () => {
        connectBtn.style.background = connectBtn.dataset.connected === 'true' ? '#4CAF50' : '#6B6AB3';
    };

    // 状态显示
    const statusEl = document.createElement('span');
    statusEl.textContent = '⚪ 未连接';
    statusEl.style.cssText = `color: #aaa; font-size: 12px; min-width: 80px; text-align: center;`;

    // 断开按钮
    const disconnectBtn = document.createElement('button');
    disconnectBtn.textContent = '⏹ 断开';
    disconnectBtn.style.cssText = `
    padding: 6px 16px;
    border: 1px solid #e74c3c;
    border-radius: 6px;
    background: transparent;
    color: #e74c3c;
    cursor: pointer;
    font-family: inherit;
    font-size: 13px;
    display: none;
    transition: all 0.2s;
  `;
    disconnectBtn.onmouseover = () => disconnectBtn.style.background = 'rgba(231,76,60,0.2)';
    disconnectBtn.onmouseout = () => disconnectBtn.style.background = 'transparent';

    // 波特率选择
    const baudSelect = document.createElement('select');
    baudSelect.style.cssText = `
    padding: 4px 8px;
    border-radius: 4px;
    background: #333;
    color: #fff;
    border: 1px solid #555;
    font-family: inherit;
    font-size: 12px;
  `;
    [9600, 19200, 38400, 57600, 115200, 230400].forEach(b => {
        const opt = document.createElement('option');
        opt.value = b;
        opt.textContent = b;
        if (b === 115200) opt.selected = true;
        baudSelect.appendChild(opt);
    });

    // ---------- 🆕 采样频率选择 ----------
    const freqSelect = document.createElement('select');
    freqSelect.style.cssText = `
    padding: 4px 8px;
    border-radius: 4px;
    background: #333;
    color: #fff;
    border: 1px solid #555;
    font-family: inherit;
    font-size: 12px;
  `;
    const freqOptions = [10, 20, 50, 100];
    freqOptions.forEach(f => {
        const opt = document.createElement('option');
        opt.value = f;
        opt.textContent = f + ' Hz';
        freqSelect.appendChild(opt);
    });
    freqSelect.value = '20'; // 默认

    // 频率设置按钮
    const freqBtn = document.createElement('button');
    freqBtn.textContent = '📶 设置频率';
    freqBtn.style.cssText = `
    padding: 6px 12px;
    border: 1px solid #f39c12;
    border-radius: 6px;
    background: transparent;
    color: #f39c12;
    cursor: pointer;
    font-family: inherit;
    font-size: 13px;
    transition: all 0.2s;
  `;
    freqBtn.onmouseover = () => freqBtn.style.background = 'rgba(243,156,18,0.2)';
    freqBtn.onmouseout = () => freqBtn.style.background = 'transparent';

    freqBtn.addEventListener('click', async () => {
        if (!fingerSerial.isConnected) {
            alert('请先连接串口');
            return;
        }
        const freq = parseInt(freqSelect.value);
        await fingerSerial.setSamplingFrequency(freq);
    });

    // 连接事件
    connectBtn.addEventListener('click', async () => {
        if (connectBtn.dataset.connected === 'true') return;
        const baud = parseInt(baudSelect.value);
        const ok = await fingerSerial.connect(baud);
        if (ok) {
            connectBtn.dataset.connected = 'true';
            connectBtn.textContent = '✅ 已连接';
            connectBtn.style.background = '#4CAF50';
            statusEl.textContent = '🟢 已连接';
            statusEl.style.color = '#4CAF50';
            disconnectBtn.style.display = 'inline-block';
        } else {
            statusEl.textContent = '🔴 连接失败';
            statusEl.style.color = '#e74c3c';
            setTimeout(() => {
                statusEl.textContent = '⚪ 未连接';
                statusEl.style.color = '#aaa';
            }, 3000);
        }
    });

    disconnectBtn.addEventListener('click', async () => {
        await fingerSerial.disconnect();
        connectBtn.dataset.connected = 'false';
        connectBtn.textContent = '🔌 连接串口';
        connectBtn.style.background = '#6B6AB3';
        statusEl.textContent = '⚪ 已断开';
        statusEl.style.color = '#aaa';
        disconnectBtn.style.display = 'none';
    });

    container.appendChild(connectBtn);
    container.appendChild(disconnectBtn);
    container.appendChild(baudSelect);

    // 添加频率选择组件
    const freqLabel = document.createElement('span');
    freqLabel.textContent = '📊 采样率:';
    freqLabel.style.cssText = `color: #aaa; font-size: 12px;`;
    container.appendChild(freqLabel);
    container.appendChild(freqSelect);
    container.appendChild(freqBtn);

    // 添加分隔线
    const divider = document.createElement('span');
    divider.textContent = '|';
    divider.style.cssText = `color: #555; margin: 0 4px;`;
    container.appendChild(divider);

    // 添加截图按钮
    const screenshotBtn = document.createElement('button');
    screenshotBtn.id = 'screenshot';
    screenshotBtn.textContent = '📷 保存图片';
    screenshotBtn.style.cssText = `
    padding: 6px 16px;
    border: 1px solid #3498db;
    border-radius: 6px;
    background: transparent;
    color: #3498db;
    cursor: pointer;
    font-family: inherit;
    font-size: 13px;
    transition: all 0.2s;
  `;
    screenshotBtn.onmouseover = () => screenshotBtn.style.background = 'rgba(52,152,219,0.2)';
    screenshotBtn.onmouseout = () => screenshotBtn.style.background = 'transparent';
    container.appendChild(screenshotBtn);

    container.appendChild(statusEl);
    document.body.appendChild(container);
}

// 启动UI
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', createSerialUI);
} else {
    createSerialUI();
}

console.log('📡 串口模块已加载，可使用 fingerSerial.setSamplingFrequency(freq) 手动设置');
console.log('💡 如需自定义指令格式，修改 fingerSerial.frequencyCommandFormat');