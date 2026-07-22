// ============================================================
// bluetooth.js - Web Bluetooth 通信 + 采样频率控制
// 使用 Nordic UART Service (NUS) 替代 Web Serial API
// 兼容标准 BLE 串口模块（如 ESP32 BLE Serial、HM-10、nRF52 等）
// ============================================================
function simulateFingerData(t, i, m, r, p, w = 0) {
    const data = { thumb: t, index: i, middle: m, ring: r, pinky: p, wrist: w };
    // 直接调用内部处理函数
    fingerSerial._processLine(JSON.stringify(data));
}

// ---------- Nordic UART Service UUID ----------
const NUS_SERVICE          = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const NUS_RX_CHARACTERISTIC = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; // 写入（PC -> 设备）
const NUS_TX_CHARACTERISTIC = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // 通知（设备 -> PC）

class BluetoothFingerController {
    constructor() {
        this.device = null;
        this.server = null;
        this.service = null;
        this.rxCharacteristic = null; // 写入
        this.txCharacteristic = null; // 通知
        this.isConnected = false;
        this.isConnecting = false;
        this.buffer = '';
        this.onFingerData = null;

        // 设备名称过滤：匹配 "right"（不区分大小写）
        this.namePrefix = 'right';

        this.FINGER_KEYS = ['thumb', 'index', 'middle', 'ring', 'pinky', 'wrist'];
        this.FINGER_MAX = {
            thumb: 0.9,
            index: 1.1,
            middle: 1.25,
            ring: 1.25,
            pinky: 1.15,
            wrist: 0.4,
        };

        // ---------- 采样频率指令格式（与 right.ino 一致） ----------
        this.frequencyCommandFormat = (freq) => `FREQ:${freq}`;
    }

    // ---------- 搜索 + 配对 + 连接 ----------
    async connect() {
        if (!('bluetooth' in navigator)) {
            alert('❌ 当前浏览器不支持 Web Bluetooth API，请使用 Chrome / Edge / Opera（HTTPS 或 localhost）。');
            return false;
        }
        if (this.isConnecting || this.isConnected) {
            console.warn('⚠️ 蓝牙正在连接或已连接');
            return false;
        }
        this.isConnecting = true;

        try {
            console.log(`🔍 正在搜索蓝牙设备（名称以 "${this.namePrefix}" 开头）...`);
            this.device = await navigator.bluetooth.requestDevice({
                // 按名称前缀过滤，方便测试 "right"
                filters: [{ namePrefix: this.namePrefix }],
                // 同时也接受所有含 NUS 服务的设备作为兜底
                optionalServices: [NUS_SERVICE],
            });
            console.log(`📱 已选择设备: ${this.device.name || this.device.id}`);

            // 监听断开事件（如设备掉电、超出范围）
            this.device.addEventListener('gattserverdisconnected', () => {
                this._onDisconnected();
            });

            console.log('🔗 正在建立 GATT 连接...');
            this.server = await this.device.gatt.connect();

            console.log('🔎 获取 Nordic UART Service...');
            this.service = await this.server.getPrimaryService(NUS_SERVICE);

            this.rxCharacteristic = await this.service.getCharacteristic(NUS_RX_CHARACTERISTIC);
            this.txCharacteristic = await this.service.getCharacteristic(NUS_TX_CHARACTERISTIC);

            // 启用通知接收数据
            await this.txCharacteristic.startNotifications();
            this.txCharacteristic.addEventListener(
                'characteristicvaluechanged',
                (event) => this._handleNotifications(event)
            );

            this.isConnected = true;
            this.isConnecting = false;
            console.log(`✅ 蓝牙已连接: ${this.device.name || this.device.id}`);
            return true;
        } catch (e) {
            this.isConnecting = false;
            console.error('❌ 蓝牙连接失败:', e);
            if (e.name === 'NotFoundError') {
                alert('未找到匹配的蓝牙设备。请确认:\n1. 设备已开机且处于广播状态\n2. 设备名称以 "right" 开头\n3. 浏览器已授予蓝牙权限');
            } else if (e.name === 'NetworkError') {
                alert('GATT 连接失败：设备可能已断电或超出范围。\n' + e.message);
            } else {
                alert('蓝牙连接失败: ' + e.message);
            }
            // 清理半连接状态
            if (this.device && this.device.gatt && this.device.gatt.connected) {
                try { this.device.gatt.disconnect(); } catch (_) {}
            }
            return false;
        }
    }

    // ---------- 主动断开 ----------
    async disconnect() {
        // 停止通知
        if (this.txCharacteristic) {
            try { await this.txCharacteristic.stopNotifications(); } catch (e) {}
        }
        if (this.device && this.device.gatt && this.device.gatt.connected) {
            try { this.device.gatt.disconnect(); } catch (e) {}
        }
        this._cleanup();
        console.log('🔌 蓝牙已断开');
    }

    _cleanup() {
        this.device = null;
        this.server = null;
        this.service = null;
        this.rxCharacteristic = null;
        this.txCharacteristic = null;
        this.isConnected = false;
        this.isConnecting = false;
        this.buffer = '';
    }

    _onDisconnected() {
        console.warn('⚠️ 设备主动断开（掉电/超出范围）');
        this._cleanup();
        // 通知 UI 更新状态
        if (this._onDisconnectCallback) this._onDisconnectCallback();
    }

    onData(callback) {
        this.onFingerData = callback;
    }

    onDisconnect(callback) {
        this._onDisconnectCallback = callback;
    }

    // ---------- 发送数据（写入 RX 特征） ----------
    async send(data) {
        if (!this.isConnected || !this.rxCharacteristic) {
            console.warn('⚠️ 蓝牙未连接，无法发送');
            return false;
        }
        try {
            const encoder = new TextEncoder();
            // BLE 单包最大 20 字节（默认 MTU），按需分片发送
            const payload = encoder.encode(data + '\n');
            const CHUNK = 20;
            if (payload.length <= CHUNK) {
                await this.rxCharacteristic.writeValueWithoutResponse(payload);
            } else {
                for (let i = 0; i < payload.length; i += CHUNK) {
                    const slice = payload.slice(i, i + CHUNK);
                    await this.rxCharacteristic.writeValueWithoutResponse(slice);
                }
            }
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

    // ---------- 接收通知数据 ----------
    _handleNotifications(event) {
        const value = event.target.value;
        const decoder = new TextDecoder();
        this.buffer += decoder.decode(value, { stream: true });

        // 防止 buffer 无限增长（如同步丢失时）
        if (this.buffer.length > 512) {
            this.buffer = this.buffer.slice(-256);
        }

        // 以 \n 为分隔符拆分行
        let lines = this.buffer.split('\n');
        this.buffer = lines.pop() || '';

        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed) {
                const ok = this._processLine(trimmed);
                if (!ok) {
                    this._parseFailCount = (this._parseFailCount || 0) + 1;
                    // 连续失败超过 10 次，尝试重新同步（清空 buffer）
                    if (this._parseFailCount > 10) {
                        this.buffer = '';
                        this._parseFailCount = 0;
                        console.warn('🔄 数据同步丢失，已重置缓冲');
                    }
                } else {
                    this._parseFailCount = 0;
                }
            }
        }

        // 处理残留缓冲中的完整 JSON
        if (this.buffer.trim().endsWith('}')) {
            const trimmed = this.buffer.trim();
            this.buffer = '';
            this._processLine(trimmed);
        }
    }

    _processLine(line) {
        // 1) CSV（BLE 默认格式，最快解析）
        if (line.includes(',') && !line.includes('{') && !line.includes(':')) {
            const parts = line.split(',').map(s => s.trim());
            if (parts.length === this.FINGER_KEYS.length) {
                const nums = parts.map(Number);
                if (nums.every(n => !isNaN(n))) {
                    const result = {};
                    for (let i = 0; i < this.FINGER_KEYS.length; i++) {
                        result[this.FINGER_KEYS[i]] = nums[i];
                    }
                    this._updateFingers(result);
                    return true;
                }
            }
        }

        // 2) JSON（兼容格式）
        if (line.startsWith('{') && line.endsWith('}')) {
            try {
                const obj = JSON.parse(line);
                const result = {};
                let ok = true;
                for (const key of this.FINGER_KEYS) {
                    if (typeof obj[key] === 'number') result[key] = obj[key];
                    else { ok = false; break; }
                }
                if (ok) { this._updateFingers(result); return true; }
            } catch (e) {}
        }

        // 3) 标签格式 "thumb:0.25,index:0.50,wrist:0.15"
        if (line.includes(':') && line.includes(',')) {
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
                return true;
            }
        }

        // 解析失败，静默计数
        return false;
    }

    _updateFingers(fingerData) {
        const mapped = {};
        for (const key of this.FINGER_KEYS) {
            const raw = fingerData[key];
            const maxVal = this.FINGER_MAX[key];
            if (key === 'wrist') {
                mapped[key] = Math.min(maxVal, Math.max(-maxVal, raw));
            } else if (raw >= 0 && raw <= 1) {
                mapped[key] = Math.min(maxVal, Math.max(0, raw * maxVal));
            } else {
                mapped[key] = Math.min(maxVal, Math.max(0, raw));
            }
        }

        // 目标值（供 rAF 插值使用）
        this._targetValues = mapped;
        if (!this._currentValues) {
            this._currentValues = { ...mapped };
        }

        // 启动插值循环（只启动一次）
        if (!this._rafRunning) {
            this._rafRunning = true;
            this._interpolateLoop();
        }

        // 每 30 帧输出一次日志
        this._frameCount = (this._frameCount || 0) + 1;
        if (this._frameCount >= 30) {
            this._frameCount = 0;
            console.log(
                mapped.thumb.toFixed(2),
                mapped.index.toFixed(2),
                mapped.middle.toFixed(2),
                mapped.ring.toFixed(2),
                mapped.pinky.toFixed(2),
                mapped.wrist.toFixed(2)
            );
        }

        if (this.onFingerData) this.onFingerData(mapped);
    }

    // rAF 插值循环：每帧平滑过渡到目标值，避免数据跳变导致卡顿
    _interpolateLoop() {
        if (!this._targetValues) {
            this._rafRunning = false;
            return;
        }

        const lerpFactor = 0.35; // 插值系数，越大跟手越快
        for (const key of this.FINGER_KEYS) {
            this._currentValues[key] += (this._targetValues[key] - this._currentValues[key]) * lerpFactor;
        }

        // 更新 UI + 骨骼
        if (window.Re) {
            for (const key of this.FINGER_KEYS) {
                window.Re[key] = this._currentValues[key];
            }
            this._updateBones(this._currentValues);
        }

        requestAnimationFrame(() => this._interpolateLoop());
    }

    _updateBones(fingerData) {
        // 缓存骨骼引用，避免每次 getObjectByName 查找
        if (!this._leftHandBones) {
            const leftHand = window.We?.getObjectByName?.('Hand');
            this._leftHandBones = leftHand?.skeleton?.bones || null;
        }
        if (this._leftHandBones) {
            const bones = this._leftHandBones;
            const boneMap = {
                wrist: [1, 2, 6, 10, 14, 18],
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

        if (!this._rightHandBones) {
            const rightHand = window.We?.getObjectByName?.('RightHand');
            this._rightHandBones = rightHand?.skeleton?.bones || null;
        }
        if (this._rightHandBones) {
            const rightBones = this._rightHandBones;
            const boneMap = {
                wrist: [1, 2, 6, 10, 14, 18],
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

        if (window.rightHandController) {
            window.rightHandController.syncWithLeft();
        }
    }
}

// ============================================================
// 创建实例并暴露全局（保持与 serial.js 相同的接口）
// ============================================================
const fingerSerial = new BluetoothFingerController();
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
    connectBtn.textContent = '🔵 连接蓝牙';
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

    // ---------- 采样频率选择 ----------
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
            alert('请先连接蓝牙设备');
            return;
        }
        const freq = parseInt(freqSelect.value);
        await fingerSerial.setSamplingFrequency(freq);
    });

    // 设备异常断开回调 -> 更新 UI
    fingerSerial.onDisconnect(() => {
        connectBtn.dataset.connected = 'false';
        connectBtn.textContent = '🔵 连接蓝牙';
        connectBtn.style.background = '#6B6AB3';
        statusEl.textContent = '🔴 设备已断开';
        statusEl.style.color = '#e74c3c';
        disconnectBtn.style.display = 'none';
        setTimeout(() => {
            statusEl.textContent = '⚪ 未连接';
            statusEl.style.color = '#aaa';
        }, 3000);
    });

    // 连接事件
    connectBtn.addEventListener('click', async () => {
        if (connectBtn.dataset.connected === 'true' || fingerSerial.isConnecting) return;
        connectBtn.textContent = '⏳ 连接中...';
        const ok = await fingerSerial.connect();
        if (ok) {
            connectBtn.dataset.connected = 'true';
            connectBtn.textContent = '✅ 已连接';
            connectBtn.style.background = '#4CAF50';
            statusEl.textContent = `🟢 已连接: ${fingerSerial.device?.name || ''}`;
            statusEl.style.color = '#4CAF50';
            disconnectBtn.style.display = 'inline-block';
        } else {
            statusEl.textContent = '🔴 连接失败';
            statusEl.style.color = '#e74c3c';
            connectBtn.textContent = '🔵 连接蓝牙';
            setTimeout(() => {
                statusEl.textContent = '⚪ 未连接';
                statusEl.style.color = '#aaa';
            }, 3000);
        }
    });

    // 断开事件
    disconnectBtn.addEventListener('click', async () => {
        await fingerSerial.disconnect();
        connectBtn.dataset.connected = 'false';
        connectBtn.textContent = '🔵 连接蓝牙';
        connectBtn.style.background = '#6B6AB3';
        statusEl.textContent = '⚪ 已断开';
        statusEl.style.color = '#aaa';
        disconnectBtn.style.display = 'none';
    });

    container.appendChild(connectBtn);
    container.appendChild(disconnectBtn);

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

console.log('📡 蓝牙模块已加载，可使用 fingerSerial.setSamplingFrequency(freq) 手动设置');
console.log('💡 设备名称需以 "right" 开头，提供 Nordic UART Service (NUS)');
