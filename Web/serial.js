// ============================================================
// serial.js - 串口通信 + 采样频率控制
// ============================================================
//
// ==================== 支持的合法数据格式 ====================
// 共支持 5 种数据格式，键名固定为 thumb/index/middle/ring/pinky/wrist
//
// 【格式1】单手JSON（左手）
//   {"thumb":0.25,"index":0.50,"middle":0.80,"ring":0.30,"pinky":0.10,"wrist":0.00}
//   说明: 必须是完整 JSON 对象，以 { 开头、} 结尾，6 个键的值均为数字。
//
// 【格式2】双手JSON
//   {"left":{"thumb":0.25,...},"right":{"thumb":0.30,...}}
//   说明: 最外层 JSON 包含 "left" 和/或 "right" 子对象，各子对象格式同【格式1】。
//         left/right 可只传其中一个，也可同时传两个。
//
// 【格式3】标签格式（左手）
//   thumb:0.25,index:0.50,middle:0.80,ring:0.30,pinky:0.10,wrist:0.00
//   说明: 包含冒号 : 分隔键值对，逗号分隔各手指，必须恰好 6 个键。
//
// 【格式4】纯CSV（左手）
//   0.25,0.50,0.80,0.30,0.10,0.00
//   说明: 6 个逗号分隔的数值，按顺序对应 thumb,index,middle,ring,pinky,wrist。
//         要求不含 { 或 : 字符（以避免与 JSON/标签格式混淆）。
//
// 【格式5】双手CSV
//   0.25,0.50,0.80,0.30,0.10,0.00, 0.30,0.55,0.85,0.35,0.15,0.05
//   说明: 12 个逗号分隔的数值，前 6 个为左手，后 6 个为右手，
//         各 6 个按顺序对应 thumb,index,middle,ring,pinky,wrist。
// ============================================================
function simulateFingerData(t, i, m, r, p, w = 0) {
    const data = { thumb: t, index: i, middle: m, ring: r, pinky: p, wrist: w };
    // 直接调用内部处理函数
    fingerSerial._processLine(JSON.stringify(data));
}

class SerialFingerController {
    constructor() {
        this.port = null;
        this.reader = null;
        this.isConnected = false;
        this.connectionType = null;   // 'serial' | 'bluetooth'
        this.buffer = '';
        this.onFingerData = null;
        // 蓝牙相关
        this.bluetoothDevice = null;
        this.bluetoothServer = null;
        this.bluetoothTxChar = null;
        this.bluetoothRxChar = null;

        // BLE Nordic UART Service (ESP32-S3 等 BLE 设备使用)
        // 可自定义：fingerSerial.bleServiceUUID / bleTxUUID / bleRxUUID
        this.bleServiceUUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
        this.bleTxUUID = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
        this.bleRxUUID = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';

        this.FINGER_KEYS = ['thumb', 'index', 'middle', 'ring', 'pinky', 'wrist'];
        this.FINGER_MAX = {
            thumb: 0.9,
            index: 1.1,
            middle: 1.25,
            ring: 1.25,
            pinky: 1.15,
            wrist: 0.4,
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
            this._calibrated = false;
            this._validCount = 0;
            this._calibrationRequired = 3;
            window.serialCalibrating = true;
            if (window.setDetectionPanel) {
                window.setDetectionPanel('<div style="color:#f39c12;">⏳ 校准中，等待有效数据...</div>');
            }
            console.log(`✅ 串口已连接 (${baudRate} bps)`);
            this.connectionType = 'serial';
            this._startReading();
            return true;
        } catch (e) {
            console.error('❌ 连接失败:', e);
            alert('串口连接失败: ' + e.message);
            return false;
        }
    }

    // ---------- BLE 蓝牙连接 (Nordic UART Service) ----------
    // ESP32-S3 等 BLE 设备使用此方法
    // 如果你的 BLE 设备使用不同 UUID，连接前修改：
    //   fingerSerial.bleServiceUUID = '你的服务UUID';
    //   fingerSerial.bleTxUUID = '你的TX特征UUID';
    //   fingerSerial.bleRxUUID = '你的RX特征UUID';
    async connectBluetooth() {
        if (!('bluetooth' in navigator)) {
            alert('❌ 当前浏览器不支持 Web Bluetooth API。\n\n' +
                '🔧 解决方案：\n' +
                '1. 确保使用 Chrome/Edge 浏览器\n' +
                '2. Linux 用户请在地址栏输入：\n' +
                '   chrome://flags/#enable-experimental-web-platform-features\n' +
                '   设为 Enabled 后重启浏览器\n' +
                '3. 或者用命令行启动：\n' +
                '   google-chrome --enable-features=WebBluetooth');
            return false;
        }
        try {
            this.bluetoothDevice = await navigator.bluetooth.requestDevice({
                filters: [{ services: [this.bleServiceUUID] }],
                optionalServices: [this.bleServiceUUID]
            });
            this.bluetoothDevice.addEventListener('gattserverdisconnected', () => {
                console.log('🔌 BLE 设备已断开');
                this.isConnected = false;
                this.connectionType = null;
            });

            this.bluetoothServer = await this.bluetoothDevice.gatt.connect();
            const service = await this.bluetoothServer.getPrimaryService(this.bleServiceUUID);

            // 🔍 先列出所有特征，诊断实际属性
            const chars = await service.getCharacteristics();
            console.log(`📋 BLE 服务 ${this.bleServiceUUID} 共有 ${chars.length} 个特征:`);
            const notifyCandidates = [];
            const writeCandidates = [];
            for (const c of chars) {
                const props = [];
                if (c.properties.read) props.push('read');
                if (c.properties.write) props.push('write');
                if (c.properties.writeWithoutResponse) props.push('writeWithoutResponse');
                if (c.properties.notify) props.push('notify');
                if (c.properties.indicate) props.push('indicate');
                console.log(`   UUID: ${c.uuid}  属性: [${props.join(', ')}]`);
                if (c.properties.notify || c.properties.indicate) notifyCandidates.push(c);
                if (c.properties.writeWithoutResponse || c.properties.write) writeCandidates.push(c);
            }

            // 优先按硬编码 UUID 匹配，失败则按属性自动适配
            // ESP32 固件实际映射: bleRxUUID(6E400003)=NOTIFY, bleTxUUID(6E400002)=WRITE
            // --- 接收特征 (notify/indicate): 使用 bleRxUUID (6E400003) ---
            try {
                this.bluetoothRxChar = await service.getCharacteristic(this.bleRxUUID);
                if (!(this.bluetoothRxChar.properties.notify || this.bluetoothRxChar.properties.indicate)) {
                    throw new Error(`特征 ${this.bleRxUUID} 不支持 notify/indicate`);
                }
                console.log(`✅ 接收(NOTIFY)特征按 UUID 匹配: ${this.bleRxUUID}`);
            } catch (e) {
                console.warn(`⚠️ UUID 匹配接收特征失败: ${e.message}，尝试按属性自动匹配...`);
                if (notifyCandidates.length > 0) {
                    this.bluetoothRxChar = notifyCandidates[0];
                    console.log(`✅ 自动匹配接收特征: ${this.bluetoothRxChar.uuid}`);
                } else {
                    throw new Error('未找到任何支持 notify/indicate 的特征，请检查 ESP32 BLE 固件配置');
                }
            }

            await this.bluetoothRxChar.startNotifications();
            this.bluetoothRxChar.addEventListener('characteristicvaluechanged', (event) => {
                const decoder = new TextDecoder();
                const value = decoder.decode(event.target.value);
                this.buffer += value;
                const lines = this.buffer.split('\n');
                this.buffer = lines.pop() || '';
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (trimmed) this._processLine(trimmed);
                }
            });
            console.log(`📡 已订阅通知: ${this.bluetoothRxChar.uuid}`);

            // --- 发送特征 (write/writeWithoutResponse): 使用 bleTxUUID (6E400002) ---
            try {
                this.bluetoothTxChar = await service.getCharacteristic(this.bleTxUUID);
                if (!(this.bluetoothTxChar.properties.writeWithoutResponse || this.bluetoothTxChar.properties.write)) {
                    throw new Error(`特征 ${this.bleTxUUID} 不支持写入`);
                }
                console.log(`✅ 发送(WRITE)特征按 UUID 匹配: ${this.bleTxUUID}`);
            } catch (e) {
                console.warn(`⚠️ UUID 匹配发送特征失败: ${e.message}，尝试按属性自动匹配...`);
                // 优先选 writeWithoutResponse
                const w = writeCandidates.find(c => c.properties.writeWithoutResponse) || writeCandidates[0];
                if (w && w.uuid !== this.bluetoothRxChar.uuid) {
                    this.bluetoothTxChar = w;
                    console.log(`✅ 自动匹配发送特征: ${this.bluetoothTxChar.uuid}`);
                } else if (!w) {
                    console.warn('⚠️ 未找到写入特征，发送功能不可用');
                }
            }

            this.isConnected = true;
            this.connectionType = 'bluetooth';
            this._calibrated = false;
            this._validCount = 0;
            this._calibrationRequired = 3;
            window.serialCalibrating = true;
            if (window.setDetectionPanel) {
                window.setDetectionPanel('<div style="color:#f39c12;">⏳ 校准中，等待有效数据...</div>');
            }
            console.log('✅ BLE 已连接:', this.bluetoothDevice.name);
            return true;
        } catch (e) {
            console.error('❌ BLE 连接失败:', e);
            alert('BLE 连接失败: ' + e.message);
            return false;
        }
    }

    async disconnect() {
        if (this.connectionType === 'bluetooth') {
            if (this.bluetoothDevice && this.bluetoothDevice.gatt.connected) {
                try { await this.bluetoothDevice.gatt.disconnect(); } catch (e) {}
            }
            this.bluetoothDevice = null;
            this.bluetoothServer = null;
            this.bluetoothTxChar = null;
            this.bluetoothRxChar = null;
        } else {
            if (this.reader) {
                try { await this.reader.cancel(); } catch (e) {}
                this.reader = null;
            }
            if (this.port) {
                try { await this.port.close(); } catch (e) {}
                this.port = null;
            }
        }
        this.isConnected = false;
        this.connectionType = null;
        console.log('🔌 已断开');
    }

    onData(callback) {
        this.onFingerData = callback;
    }

    // ---------- 发送数据 ----------
    async send(data) {
        if (!this.isConnected) {
            console.warn('⚠️ 未连接，无法发送');
            return false;
        }
        try {
            if (this.connectionType === 'bluetooth') {
                if (!this.bluetoothTxChar) {
                    console.warn('⚠️ BLE 发送特征不可用');
                    return false;
                }
                const encoder = new TextEncoder();
                const buf = encoder.encode(data + '\n');
                if (this.bluetoothTxChar.properties.writeWithoutResponse) {
                    await this.bluetoothTxChar.writeValueWithoutResponse(buf);
                } else {
                    await this.bluetoothTxChar.writeValue(buf);
                }
            } else {
                const writer = this.port.writable.getWriter();
                const encoder = new TextEncoder();
                await writer.write(encoder.encode(data + '\n'));
                writer.releaseLock();
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
        // 跳过纯文本日志/警告行（不影响解析和校准计数）
        if (/^(Warning|Error|ESP-ROM|BLE |====|初始化|Right Device|请将|倒计时|CH\d|等待|JSON格式|指令格式|准备|弯曲电压|MAC)/.test(line)) return;

        // 校准期间：将原始串口数据输出到检测面板
        if (!this._calibrated && window.appendDetectionPanel) {
            const escaped = line.replace(/</g, '&lt;').replace(/>/g, '&gt;');
            window.appendDetectionPanel(`<div style="color:#aaa;font-size:11px;border-bottom:1px solid #333;padding:2px 0;">📥 ${escaped}</div>`);
            const panel = window.getDetectionPanel?.();
            if (panel) panel.scrollTop = panel.scrollHeight;
        }

        // 1) JSON
        if (line.startsWith('{') && line.endsWith('}')) {
            try {
                const obj = JSON.parse(line);

                // 1a) 双手格式 {"left":{...},"right":{...}}
                if (obj.left || obj.right) {
                    if (obj.left) {
                        const leftResult = this._validateFingerObj(obj.left);
                        if (leftResult) this._updateFingers(leftResult);
                    }
                    if (obj.right) {
                        const rightResult = this._validateFingerObj(obj.right);
                        if (rightResult) this._updateRightFingers(rightResult);
                    }
                    if (obj.left || obj.right) {
                        this._onValidLine();
                        return;
                    }
                }

                // 1b) 单手格式 {"thumb":0.25,...}
                const result = this._validateFingerObj(obj);
                if (result) { this._onValidLine(); this._updateFingers(result); return; }
            } catch (e) {}
        }

        // 2) 标签格式 "thumb:0.25,index:0.50,wrist:0.15"
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
                this._onValidLine(); this._updateFingers(result); return;
            }
        }

        // 3) 双手 CSV "25,50,80,...或0.25,0.50,0.80,..." (12个值: 左手6个 + 右手6个)
        const parts = line.split(',').map(s => s.trim());
        if (parts.length >= this.FINGER_KEYS.length * 2) {
            const leftNums = parts.slice(0, this.FINGER_KEYS.length).map(Number);
            const rightNums = parts.slice(this.FINGER_KEYS.length, this.FINGER_KEYS.length * 2).map(Number);
            if (leftNums.every(n => !isNaN(n)) && rightNums.every(n => !isNaN(n))) {
                const leftResult = {};
                const rightResult = {};
                for (let i = 0; i < this.FINGER_KEYS.length; i++) {
                    // 整数编码兼容：值>1时为整数编码（0-100），除以100还原
                    leftResult[this.FINGER_KEYS[i]] = leftNums[i] > 1 ? leftNums[i] / 100 : leftNums[i];
                    rightResult[this.FINGER_KEYS[i]] = rightNums[i] > 1 ? rightNums[i] / 100 : rightNums[i];
                }
                this._onValidLine();
                this._updateFingers(leftResult);
                this._updateRightFingers(rightResult);
                return;
            }
        }

        // 4) 纯 CSV "25,50,80,30,10,0 或 0.25,0.50,..." (6个值: 左手)
        if (parts.length >= this.FINGER_KEYS.length) {
            const nums = parts.slice(0, this.FINGER_KEYS.length).map(Number);
            if (nums.every(n => !isNaN(n))) {
                const result = {};
                for (let i = 0; i < this.FINGER_KEYS.length; i++) {
                    result[this.FINGER_KEYS[i]] = nums[i] > 1 ? nums[i] / 100 : nums[i];
                }
                this._onValidLine(); this._updateFingers(result); return;
            }
        }

        console.warn('⚠️ 无法解析串口数据:', line);
        this._validCount = 0;
    }

    _validateFingerObj(obj) {
        const result = {};
        for (const key of this.FINGER_KEYS) {
            if (typeof obj[key] !== 'number') return null;
            result[key] = obj[key];
        }
        return result;
    }

    _onValidLine() {
        if (this._calibrated) return;
        this._validCount = (this._validCount || 0) + 1;
        if (this._validCount >= this._calibrationRequired) {
            this._calibrated = true;
            window.serialCalibrating = false;
            if (window.setDetectionPanel) {
                window.setDetectionPanel('<div style="color:#8f8;font-size:14px;font-weight:bold;">✅ 校准成功</div>');
                // 2 秒后清除，恢复为 WebSocket 检测结果显示
                setTimeout(() => {
                    if (window.setDetectionPanel) {
                        window.setDetectionPanel('');
                    }
                }, 2000);
            }
            console.log('✅ 串口校准完成，开始接收手指数据');
        }
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

        if (window.Re) {
            for (const key of this.FINGER_KEYS) {
                window.Re[key] = mapped[key];
            }
            // 节流UI刷新：每10帧刷新一次，避免DOM操作阻塞动画
            this._uiRefreshCount = (this._uiRefreshCount || 0) + 1;
            if (this._uiRefreshCount >= 10 && window.Vi) {
                this._uiRefreshCount = 0;
                window.Vi.refresh();
            }
            this._updateBones(mapped);
        }

        // 节流日志：每10帧输出一次
        this._logCount = (this._logCount || 0) + 1;
        if (this._logCount >= 10) {
            this._logCount = 0;
            console.log('🖐️ 手指值:', Object.entries(mapped)
                .map(([k, v]) => `${k}:${v.toFixed(3)}`).join(' '));
        }

        if (this.onFingerData) this.onFingerData(mapped);
    }

    _updateRightFingers(fingerData) {
        if (!fingerData) return;
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

        // 同步右手骨骼
        const rightHand = window.We?.getObjectByName?.('RightHand');
        if (rightHand && rightHand.skeleton) {
            const bones = rightHand.skeleton.bones;
            if (bones) {
                const boneMap = {
                    wrist: [1, 2, 6, 10, 14, 18],
                    thumb: [3, 4, 5],
                    index: [7, 8, 9],
                    middle: [11, 12, 13],
                    ring: [15, 16, 17],
                    pinky: [19, 20, 21],
                };
                for (const [key, indices] of Object.entries(boneMap)) {
                    const val = mapped[key] || 0;
                    for (const idx of indices) {
                        if (bones[idx]) bones[idx].rotation.x = val;
                    }
                }
            }
        }

        // 同步右手 Tweakpane 参数（复用左手的节流计数器）
        if (window.RIGHT_PARAMS) {
            for (const key of this.FINGER_KEYS) {
                window.RIGHT_PARAMS[key] = mapped[key];
            }
            // UI刷新已在 _updateFingers 中节流处理，此处不再重复调用
        }

        // 节流日志：每10帧输出一次
        this._rightLogCount = (this._rightLogCount || 0) + 1;
        if (this._rightLogCount >= 10) {
            this._rightLogCount = 0;
            console.log('🤚 右手手指值:', Object.entries(mapped)
                .map(([k, v]) => `${k}:${v.toFixed(3)}`).join(' '));
        }
    }

    _updateBones(fingerData) {
        // 只更新左手骨骼，右手由 _updateRightFingers 独立控制
        const hand = window.We?.getObjectByName?.('Hand');
        if (hand && hand.skeleton) {
            const bones = hand.skeleton.bones;
            if (bones) {
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

    // 连接按钮（USB串口）
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

    // 蓝牙连接按钮
    const bluetoothBtn = document.createElement('button');
    bluetoothBtn.textContent = '📶 连接蓝牙';
    bluetoothBtn.style.cssText = `
    padding: 6px 16px;
    border: 1px solid #3498db;
    border-radius: 6px;
    background: #3498db;
    color: #fff;
    cursor: pointer;
    font-family: inherit;
    font-size: 13px;
    transition: all 0.2s;
  `;
    bluetoothBtn.onmouseover = () => bluetoothBtn.style.background = '#5dade2';
    bluetoothBtn.onmouseout = () => {
        bluetoothBtn.style.background = bluetoothBtn.dataset.connected === 'true' ? '#4CAF50' : '#3498db';
    };

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

    // 串口连接事件
    connectBtn.addEventListener('click', async () => {
        if (connectBtn.dataset.connected === 'true' || bluetoothBtn.dataset.connected === 'true') return;
        const baud = parseInt(baudSelect.value);
        const ok = await fingerSerial.connect(baud);
        if (ok) {
            connectBtn.dataset.connected = 'true';
            connectBtn.textContent = '✅ 串口已连接';
            connectBtn.style.background = '#4CAF50';
            bluetoothBtn.style.display = 'none';
            disconnectBtn.style.display = 'inline-block';
        }
    });

    // 蓝牙连接事件
    bluetoothBtn.addEventListener('click', async () => {
        if (connectBtn.dataset.connected === 'true' || bluetoothBtn.dataset.connected === 'true') return;
        const ok = await fingerSerial.connectBluetooth();
        if (ok) {
            bluetoothBtn.dataset.connected = 'true';
            bluetoothBtn.textContent = '✅ 蓝牙已连接';
            bluetoothBtn.style.background = '#4CAF50';
            connectBtn.style.display = 'none';
            disconnectBtn.style.display = 'inline-block';
        }
    });

    disconnectBtn.addEventListener('click', async () => {
        await fingerSerial.disconnect();
        connectBtn.dataset.connected = 'false';
        connectBtn.textContent = '🔌 连接串口';
        connectBtn.style.background = '#6B6AB3';
        connectBtn.style.display = 'inline-block';
        bluetoothBtn.dataset.connected = 'false';
        bluetoothBtn.textContent = '📶 连接蓝牙';
        bluetoothBtn.style.background = '#3498db';
        bluetoothBtn.style.display = 'inline-block';
        disconnectBtn.style.display = 'none';
    });

    container.appendChild(connectBtn);
    container.appendChild(bluetoothBtn);
    container.appendChild(disconnectBtn);
    container.appendChild(baudSelect);

    // 添加频率选择组件
    const freqLabel = document.createElement('span');
    freqLabel.textContent = '📊 采样率:';
    freqLabel.style.cssText = `color: #aaa; font-size: 12px;`;
    container.appendChild(freqLabel);
    container.appendChild(freqSelect);
    container.appendChild(freqBtn);

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