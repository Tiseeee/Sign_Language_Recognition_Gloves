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
        this.rxCharacteristic = null;
        this.txCharacteristic = null;
        this.isConnected = false;
        this.isConnecting = false;
        this.buffer = '';
        this.onFingerData = null;

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

        // ---------- 数据滤波配置（解决跳变问题） ----------
        this.FILTER_WINDOW_SIZE = 5;        // 中值滤波窗口大小
        this.MAX_DELTA = 0.15;              // 最大变化率（每帧最大变化量）
        this.LERP_FACTOR = 0.3;             // 线性插值因子（0-1，越小越平滑）

        // 历史数据缓冲区（用于中值滤波）
        this._leftHistory = {};
        this._rightHistory = {};
        // 当前平滑值（用于变化率限制和低通滤波）
        this._leftSmoothed = {};
        this._rightSmoothed = {};
        for (const key of this.FINGER_KEYS) {
            this._leftHistory[key] = [];
            this._rightHistory[key] = [];
            this._leftSmoothed[key] = 0;
            this._rightSmoothed[key] = 0;
        }

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

    // ---------- 显示设备状态/校准提示 ----------
    _showMessage(msg) {
        let el = document.getElementById('ble-message');
        if (!el) {
            el = document.createElement('div');
            el.id = 'ble-message';
            el.style.cssText = `
                position: fixed;
                top: 24px;
                left: 50%;
                transform: translateX(-50%);
                z-index: 1001;
                background: rgba(0,0,0,0.85);
                color: #fff;
                padding: 14px 28px;
                border-radius: 10px;
                font-family: 'IBM Plex Mono', monospace;
                font-size: 16px;
                font-weight: 600;
                display: none;
                border: 2px solid #6B6AB3;
                backdrop-filter: blur(8px);
                box-shadow: 0 4px 20px rgba(0,0,0,0.4);
                text-align: center;
                min-width: 200px;
                transition: opacity 0.3s;
            `;
            document.body.appendChild(el);
        }
        el.textContent = msg;
        el.style.display = 'block';
        el.style.opacity = '1';

        // 根据提示类型设置边框颜色
        if (msg.includes('完成')) {
            el.style.borderColor = '#4CAF50';
        } else if (msg.includes('倒计时')) {
            el.style.borderColor = '#f39c12';
        } else if (msg.includes('开始') || msg.includes('伸直') || msg.includes('弯曲')) {
            el.style.borderColor = '#6B6AB3';
        } else if (msg.includes('WAIT') || msg.includes('等待')) {
            el.style.borderColor = '#3498db';
        }

        // "完成"提示 3 秒后淡出，其他保持显示
        clearTimeout(this._msgTimer);
        if (msg.includes('完成')) {
            this._msgTimer = setTimeout(() => {
                el.style.opacity = '0';
                setTimeout(() => { el.style.display = 'none'; }, 300);
            }, 3000);
        }
        console.log('📢', msg);
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

        if (this.buffer.length > 1024) {
            const idx = this.buffer.lastIndexOf('\n');
            if (idx > 0) {
                this.buffer = this.buffer.slice(idx + 1);
            } else {
                this.buffer = '';
            }
        }

        let lines = this.buffer.split('\n');
        this.buffer = lines.pop() || '';

        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed) {
                this._processLine(trimmed);
            }
        }
    }

    _processLine(line) {
        // 快速路径：最常用的双手CSV格式优先匹配（12个值）
        const firstChar = line.charCodeAt(0);
        if (firstChar >= 48 && firstChar <= 57 || firstChar === 45) {
            const commaCount = (line.match(/,/g) || []).length;
            if (commaCount === 11) {
                const parts = line.split(',');
                const nums = new Array(12);
                let allValid = true;
                for (let i = 0; i < 12; i++) {
                    const n = parseFloat(parts[i]);
                    if (isNaN(n)) { allValid = false; break; }
                    nums[i] = n;
                }
                if (allValid) {
                    const leftResult = {
                        thumb: nums[0] > 1 ? nums[0] / 100 : nums[0],
                        index: nums[1] > 1 ? nums[1] / 100 : nums[1],
                        middle: nums[2] > 1 ? nums[2] / 100 : nums[2],
                        ring: nums[3] > 1 ? nums[3] / 100 : nums[3],
                        pinky: nums[4] > 1 ? nums[4] / 100 : nums[4],
                        wrist: nums[5] > 1 ? nums[5] / 100 : nums[5]
                    };
                    const rightResult = {
                        thumb: nums[6] > 1 ? nums[6] / 100 : nums[6],
                        index: nums[7] > 1 ? nums[7] / 100 : nums[7],
                        middle: nums[8] > 1 ? nums[8] / 100 : nums[8],
                        ring: nums[9] > 1 ? nums[9] / 100 : nums[9],
                        pinky: nums[10] > 1 ? nums[10] / 100 : nums[10],
                        wrist: nums[11] > 1 ? nums[11] / 100 : nums[11]
                    };
                    this._updateFingers(leftResult);
                    this._updateRightFingers(rightResult);
                    return true;
                }
            }
        }

        // 校准/状态提示
        if (firstChar === 26681 || firstChar === 91) {
            if (line.startsWith('校准:') || line.startsWith('[WAIT]')) {
                this._showMessage(line);
                return true;
            }
        }

        // 单手CSV（6个值）
        if (line.includes(',') && !line.includes('{') && !line.includes(':')) {
            const parts = line.split(',').map(s => s.trim());
            if (parts.length === 6) {
                const nums = parts.map(Number);
                if (nums.every(n => !isNaN(n))) {
                    const result = {};
                    for (let i = 0; i < 6; i++) {
                        result[this.FINGER_KEYS[i]] = nums[i] > 1 ? nums[i] / 100 : nums[i];
                    }
                    this._updateFingers(result);
                    return true;
                }
            }
        }

        // JSON兼容格式
        if (line.startsWith('{') && line.endsWith('}')) {
            try {
                const obj = JSON.parse(line);
                if (obj.left || obj.right) {
                    if (obj.left) {
                        const leftResult = this._validateFingerObj(obj.left);
                        if (leftResult) this._updateFingers(leftResult);
                    }
                    if (obj.right) {
                        const rightResult = this._validateFingerObj(obj.right);
                        if (rightResult) this._updateRightFingers(rightResult);
                    }
                    if (obj.left || obj.right) return true;
                }
                const result = this._validateFingerObj(obj);
                if (result) { this._updateFingers(result); return true; }
            } catch (e) {}
        }

        // 标签格式
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
            if (ok && Object.keys(result).length === 6) {
                this._updateFingers(result);
                return true;
            }
        }

        return false;
    }

    _validateFingerObj(obj) {
        const result = {};
        for (const key of this.FINGER_KEYS) {
            if (typeof obj[key] !== 'number') return null;
            result[key] = obj[key];
        }
        return result;
    }

    _updateFingers(fingerData) {
        const mapped = this._mapFingerData(fingerData);

        const smoothed = {};
        for (const key of this.FINGER_KEYS) {
            if (key === 'wrist') {
                smoothed[key] = 0;
                continue;
            }

            const current = mapped[key];
            const history = this._leftHistory[key];
            
            history.push(current);
            if (history.length > this.FILTER_WINDOW_SIZE) {
                history.shift();
            }

            let filtered = current;
            if (history.length >= 3) {
                const sorted = [...history].sort((a, b) => a - b);
                filtered = sorted[Math.floor(sorted.length / 2)];
            }

            const prev = this._leftSmoothed[key];
            const delta = filtered - prev;
            const clampedDelta = Math.max(-this.MAX_DELTA, Math.min(this.MAX_DELTA, delta));
            const lerped = prev + clampedDelta;
            const final = lerped * (1 - this.LERP_FACTOR) + filtered * this.LERP_FACTOR;

            smoothed[key] = Math.max(0, Math.min(this.FINGER_MAX[key], final));
            this._leftSmoothed[key] = smoothed[key];
        }

        this._targetValues = smoothed;
        if (!this._currentValues) {
            this._currentValues = { ...smoothed };
        }

        if (!this._rafRunning) {
            this._rafRunning = true;
            this._interpolateLoop();
        }

        if (this.onFingerData) this.onFingerData(smoothed);
    }

    _updateRightFingers(fingerData) {
        if (!fingerData) return;
        const mapped = this._mapFingerData(fingerData);

        const smoothed = {};
        for (const key of this.FINGER_KEYS) {
            if (key === 'wrist') {
                smoothed[key] = 0;
                continue;
            }

            const current = mapped[key];
            const history = this._rightHistory[key];
            
            history.push(current);
            if (history.length > this.FILTER_WINDOW_SIZE) {
                history.shift();
            }

            let filtered = current;
            if (history.length >= 3) {
                const sorted = [...history].sort((a, b) => a - b);
                filtered = sorted[Math.floor(sorted.length / 2)];
            }

            const prev = this._rightSmoothed[key];
            const delta = filtered - prev;
            const clampedDelta = Math.max(-this.MAX_DELTA, Math.min(this.MAX_DELTA, delta));
            const lerped = prev + clampedDelta;
            const final = lerped * (1 - this.LERP_FACTOR) + filtered * this.LERP_FACTOR;

            smoothed[key] = Math.max(0, Math.min(this.FINGER_MAX[key], final));
            this._rightSmoothed[key] = smoothed[key];
        }

        this._rightTargetValues = smoothed;
        if (!this._rightCurrentValues) {
            this._rightCurrentValues = { ...smoothed };
        }
    }

    _mapFingerData(fingerData) {
        const mapped = {};
        for (const key of this.FINGER_KEYS) {
            const raw = fingerData[key];
            const maxVal = this.FINGER_MAX[key];
            if (key === 'wrist') {
                mapped[key] = 0;
            } else if (typeof raw !== 'number' || isNaN(raw)) {
                mapped[key] = 0;
            } else if (raw > 1) {
                mapped[key] = Math.min(maxVal, Math.max(0, (raw / 100.0) * maxVal));
            } else if (raw >= 0 && raw <= 1) {
                mapped[key] = Math.min(maxVal, Math.max(0, raw * maxVal));
            } else {
                mapped[key] = 0;
            }
        }
        return mapped;
    }

    // rAF 插值循环：每帧平滑过渡到目标值，避免数据跳变导致卡顿
    _interpolateLoop() {
        const lerpFactor = 0.35;
        const keys = this.FINGER_KEYS;

        if (this._targetValues) {
            if (!this._currentValues) this._currentValues = { ...this._targetValues };
            const cur = this._currentValues;
            const tgt = this._targetValues;
            for (let i = 0; i < 6; i++) {
                const key = keys[i];
                cur[key] += (tgt[key] - cur[key]) * lerpFactor;
            }
            if (window.Re) {
                for (let i = 0; i < 6; i++) {
                    const key = keys[i];
                    window.Re[key] = cur[key];
                }
            }
            this._updateLeftBones(cur);
        }

        if (this._rightTargetValues) {
            if (!this._rightCurrentValues) this._rightCurrentValues = { ...this._rightTargetValues };
            const cur = this._rightCurrentValues;
            const tgt = this._rightTargetValues;
            for (let i = 0; i < 6; i++) {
                const key = keys[i];
                cur[key] += (tgt[key] - cur[key]) * lerpFactor;
            }
            if (window.RIGHT_PARAMS) {
                for (let i = 0; i < 6; i++) {
                    const key = keys[i];
                    window.RIGHT_PARAMS[key] = cur[key];
                }
            }
            this._updateRightBones(cur);
        }

        if (!this._targetValues && !this._rightTargetValues) {
            this._rafRunning = false;
            return;
        }

        requestAnimationFrame(() => this._interpolateLoop());
    }

    _getLeftBones() {
        if (this._leftHandBones) return this._leftHandBones;
        const leftHand = window.We?.getObjectByName?.('Hand');
        this._leftHandBones = leftHand?.skeleton?.bones || null;
        return this._leftHandBones;
    }

    _getRightBones() {
        if (this._rightHandBones) return this._rightHandBones;
        const rightHand = window.We?.getObjectByName?.('RightHand');
        this._rightHandBones = rightHand?.skeleton?.bones || null;
        return this._rightHandBones;
    }

    _updateLeftBones(fingerData) {
        const bones = this._getLeftBones();
        if (!bones) return;

        const wristVal = fingerData.wrist || 0;
        bones[1].rotation.x = wristVal;
        bones[2].rotation.x = wristVal;
        bones[6].rotation.x = wristVal;
        bones[10].rotation.x = wristVal;
        bones[14].rotation.x = wristVal;
        bones[18].rotation.x = wristVal;

        const thumbVal = fingerData.thumb || 0;
        bones[3].rotation.x = thumbVal;
        bones[4].rotation.x = thumbVal;
        bones[5].rotation.x = thumbVal;

        const indexVal = fingerData.index || 0;
        bones[7].rotation.x = indexVal;
        bones[8].rotation.x = indexVal;
        bones[9].rotation.x = indexVal;

        const middleVal = fingerData.middle || 0;
        bones[11].rotation.x = middleVal;
        bones[12].rotation.x = middleVal;
        bones[13].rotation.x = middleVal;

        const ringVal = fingerData.ring || 0;
        bones[15].rotation.x = ringVal;
        bones[16].rotation.x = ringVal;
        bones[17].rotation.x = ringVal;

        const pinkyVal = fingerData.pinky || 0;
        bones[19].rotation.x = pinkyVal;
        bones[20].rotation.x = pinkyVal;
        bones[21].rotation.x = pinkyVal;
    }

    _updateRightBones(fingerData) {
        const bones = this._getRightBones();
        if (!bones) return;

        const wristVal = fingerData.wrist || 0;
        bones[1].rotation.x = wristVal;
        bones[2].rotation.x = wristVal;
        bones[6].rotation.x = wristVal;
        bones[10].rotation.x = wristVal;
        bones[14].rotation.x = wristVal;
        bones[18].rotation.x = wristVal;

        const thumbVal = fingerData.thumb || 0;
        bones[3].rotation.x = thumbVal;
        bones[4].rotation.x = thumbVal;
        bones[5].rotation.x = thumbVal;

        const indexVal = fingerData.index || 0;
        bones[7].rotation.x = indexVal;
        bones[8].rotation.x = indexVal;
        bones[9].rotation.x = indexVal;

        const middleVal = fingerData.middle || 0;
        bones[11].rotation.x = middleVal;
        bones[12].rotation.x = middleVal;
        bones[13].rotation.x = middleVal;

        const ringVal = fingerData.ring || 0;
        bones[15].rotation.x = ringVal;
        bones[16].rotation.x = ringVal;
        bones[17].rotation.x = ringVal;

        const pinkyVal = fingerData.pinky || 0;
        bones[19].rotation.x = pinkyVal;
        bones[20].rotation.x = pinkyVal;
        bones[21].rotation.x = pinkyVal;
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
