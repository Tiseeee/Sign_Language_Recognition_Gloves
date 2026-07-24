/*
 * Flex Sensor 5-Channel + MPU6050 Gesture Recognition - Right Device
 * 
 * 功能：接收left设备的ESP-NOW数据，整合本地传感器数据，通过BLE转发至网页控制模型
 * 
 * ESP-NOW 数据接收协议格式（与left设备一致）：
 * +------------------------------------------------------------+
 * | 字段        | 长度(字节) | 说明                              |
 * +------------------------------------------------------------+
 * | 帧头(0xAA)  | 1          | 帧起始标识                        |
 * | 版本号      | 1          | 协议版本，当前为1                 |
 * | 数据类型    | 1          | 0x01=传感器数据                   |
 * | 拇指弯曲度  | 1          | 0-100%                            |
 * | 食指弯曲度  | 1          | 0-100%                            |
 * | 中指弯曲度  | 1          | 0-100%                            |
 * | 无名指弯曲度| 1          | 0-100%                            |
 * | 小指弯曲度  | 1          | 0-100%                            |
 * | 手腕角度    | 2          | 小端格式，范围-400~400（实际值/1000）|
 * | 数据包序号  | 2          | 小端格式，递增序号                |
 * | CRC校验     | 2          | CRC16-CCITT校验                   |
 * | 帧尾(0x55)  | 1          | 帧结束标识                        |
 * +------------------------------------------------------------+
 * 总长度：17字节
 * 
 * 数据整合与转发流程图：
 * left设备 → ESP-NOW → 数据校验 → 缓存 → 整合本地数据 → BLE → 网页控制模型
 *                                                      ↑
 *                                                 本地传感器采样
 * 
 * BLE输出格式（CSV，经 BLE Nordic UART Service 传输）：
 * L_thumb,L_index,L_middle,L_ring,L_pinky,L_wrist,R_thumb,R_index,R_middle,R_ring,R_pinky,R_wrist
 * 
 * 蓝牙指令（通过 BLE NUS RX 特征写入）：
 * FREQ:10   -> 设置采样频率为 10 Hz
 * FREQ:20   -> 设置采样频率为 20 Hz
 * FREQ:50   -> 设置采样频率为 50 Hz
 * FREQ:100  -> 设置采样频率为 100 Hz
 * CALIBRATE -> 开始校准
 * 
 * 设备名称：right （bluetooth.js 按此前缀过滤搜索）
 */

#include <Arduino.h>
#include <math.h>
#include <Wire.h>
#include <esp_now.h>
#include <esp_wifi.h>
#include <WiFi.h>

// ========== ESP32 BLE (Nordic UART Service) ==========
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEService.h>
#include <BLECharacteristic.h>
#include <BLEUtils.h>
#include <BLE2902.h>

#define NUS_SERVICE_UUID          "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
#define NUS_RX_CHAR_UUID          "6e400002-b5a3-f393-e0a9-e50e24dcca9e"  // PC -> Device (write)
#define NUS_TX_CHAR_UUID          "6e400003-b5a3-f393-e0a9-e50e24dcca9e"  // Device -> PC (notify)

#define FLEX_COUNT 5

// ========== ESP-NOW 配置 ==========
#define ESPNOW_CHANNEL    1     // ESPNOW信道（需与left设备一致）
#define MAX_RECV_QUEUE_SIZE 8   // 接收队列大小
#define RECV_TIMEOUT_MS   1000  // 接收超时时间（毫秒）
#define CALIB_CMD_DATA_TYPE 0x02  // 校准指令数据类型（同步触发left校准）
#define READY_DATA_TYPE    0x03  // 就绪心跳数据类型（left校准前定期发送）

// Left设备MAC地址（用于发送校准指令）
uint8_t left_mac_addr[] = {0x10, 0x51, 0xDB, 0x85, 0xA4, 0x6C};

// ========== ESP-NOW 数据结构体 ==========
typedef struct {
    uint8_t header;           // 帧头，固定0xAA
    uint8_t version;          // 协议版本
    uint8_t data_type;        // 数据类型
    uint8_t thumb;            // 拇指弯曲度 0-100
    uint8_t index;            // 食指弯曲度 0-100
    uint8_t middle;           // 中指弯曲度 0-100
    uint8_t ring;             // 无名指弯曲度 0-100
    uint8_t pinky;            // 小指弯曲度 0-100
    int16_t wrist;            // 手腕角度（放大1000倍）
    uint16_t seq_num;         // 数据包序号
    uint16_t crc;             // CRC校验
    uint8_t tail;             // 帧尾，固定0x55
} EspNowDataFrame;

#define DATA_FRAME_SIZE sizeof(EspNowDataFrame)
#define CRC_DATA_LENGTH 12    // CRC校验覆盖的字节数（header到seq_num，不含CRC和tail）

// ========== ESP-NOW 接收队列 ==========
typedef struct {
    EspNowDataFrame frame;
    unsigned long recv_time;
} RecvQueueItem;

RecvQueueItem recv_queue[MAX_RECV_QUEUE_SIZE];
int recv_queue_head = 0;
int recv_queue_tail = 0;
bool espnow_initialized = false;
uint16_t last_recv_seq = 0;
volatile bool left_ready = false;              // left设备是否在线（收到就绪心跳）
volatile unsigned long left_ready_time = 0;    // 上次收到就绪心跳的时间

// ========== 左右手数据缓存 ==========
typedef struct {
    float thumb;
    float index;
    float middle;
    float ring;
    float pinky;
    float wrist;
    unsigned long update_time;
    bool valid;
} HandData;

HandData left_hand_data = {0};
HandData right_hand_data = {0};

// ========== BLE 全局状态 ==========
BLEServer* pServer = nullptr;
BLEService* pService = nullptr;
BLECharacteristic* pTxCharacteristic = nullptr;
BLECharacteristic* pRxCharacteristic = nullptr;
bool bleDeviceConnected = false;
unsigned long bleDisconnectTime = 0;
const unsigned long BLE_RECONNECT_INTERVAL = 2000;

String bleRxBuffer = "";
String bleTxBuffer = "";
unsigned long bleReadTimeoutMs = 1000;

#define BLE_MTU  185   // BLE MTU大小（默认23，协商后可达~185）
#define BLE_NOTIFY_CHUNK  20  // 单次notify最大字节数（默认MTU下）

// ---------- BLE 回调：连接 / 断开 ----------
class BleServerCallbacks : public BLEServerCallbacks {
    void onConnect(BLEServer* server) override {
        bleDeviceConnected = true;
        Serial.println("[BLE] 设备已连接");

        // 停止广播，节省射频资源
        BLEDevice::stopAdvertising();
    }
    void onDisconnect(BLEServer* server) override {
        bleDeviceConnected = false;
        bleDisconnectTime = millis();
        Serial.println("[BLE] 设备已断开，将在2秒后重新广播");
    }
};

// ---------- BLE 回调：接收 PC -> Device 数据 ----------
class BleRxCallbacks : public BLECharacteristicCallbacks {
    void onWrite(BLECharacteristic* pCharacteristic) override {
        std::string value = pCharacteristic->getValue();
        for (size_t i = 0; i < value.length(); i++) {
            bleRxBuffer += value[i];
        }
    }
};

// ====================================================
// BLESerial - 模拟 Serial 接口，仅传输 JSON + 指令
// ====================================================
class BLESerialClass {
public:
    void begin(const char* deviceName) {
        BLEDevice::init(deviceName);

        // 设置本地MTU为185字节（默认23字节）
        // 提高单次notify传输容量：一行CSV数据约35字节可一次发送完成
        BLEDevice::setMTU(185);

        pServer = BLEDevice::createServer();
        pServer->setCallbacks(new BleServerCallbacks());

        pService = pServer->createService(NUS_SERVICE_UUID);

        pTxCharacteristic = pService->createCharacteristic(
            NUS_TX_CHAR_UUID,
            BLECharacteristic::PROPERTY_NOTIFY | BLECharacteristic::PROPERTY_READ
        );
        pTxCharacteristic->addDescriptor(new BLE2902());

        pRxCharacteristic = pService->createCharacteristic(
            NUS_RX_CHAR_UUID,
            BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR | BLECharacteristic::PROPERTY_READ
        );
        pRxCharacteristic->setCallbacks(new BleRxCallbacks());

        pService->start();

        BLEAdvertising* pAdvertising = BLEDevice::getAdvertising();
        pAdvertising->addServiceUUID(NUS_SERVICE_UUID);
        // 启用扫描响应：设备名通过扫描响应包广播，确保网页端 namePrefix 过滤能发现设备
        pAdvertising->setScanResponse(true);
        // 优化广播间隔：20ms~40ms，加快被浏览器发现的速率（单位 0.625ms）
        pAdvertising->setMinInterval(0x20);   // 32 * 0.625ms = 20ms
        pAdvertising->setMaxInterval(0x50);   // 80 * 0.625ms = 50ms
        BLEDevice::startAdvertising();
    }

    void setTimeout(unsigned long ms) { bleReadTimeoutMs = ms; }

    bool available() {
        return bleRxBuffer.length() > 0;
    }

    String readStringUntil(char terminator) {
        int idx = bleRxBuffer.indexOf(terminator);
        if (idx < 0) {
            unsigned long start = millis();
            while (idx < 0 && millis() - start < bleReadTimeoutMs) {
                idx = bleRxBuffer.indexOf(terminator);
                delay(1);
            }
            if (idx < 0) {
                String s = bleRxBuffer;
                bleRxBuffer = "";
                return s;
            }
        }
        String s = bleRxBuffer.substring(0, idx);
        bleRxBuffer = bleRxBuffer.substring(idx + 1);
        return s;
    }

    size_t print(const String& s) { _append(s); return s.length(); }
    size_t print(const char* s) { _append(String(s)); return strlen(s); }
    size_t print(char c) { _append(String(c)); return 1; }
    size_t print(int n) { String s(n); _append(s); return s.length(); }
    size_t print(unsigned int n) { String s(n); _append(s); return s.length(); }
    size_t print(long n) { String s(n); _append(s); return s.length(); }
    size_t print(unsigned long n) { String s(n); _append(s); return s.length(); }
    size_t print(double n, int prec = 2) {
        String s(n, prec);
        _append(s);
        return s.length();
    }

    size_t println() { _append("\n"); return 1; }
    size_t println(const String& s) { _append(s); _append("\n"); return s.length() + 1; }
    size_t println(const char* s) { _append(String(s)); _append("\n"); return strlen(s) + 1; }
    size_t println(int n) { String s(n); _append(s); _append("\n"); return s.length() + 1; }

    size_t printf(const char* format, ...) {
        va_list args;
        va_start(args, format);
        char buf[256];
        int n = vsnprintf(buf, sizeof(buf), format, args);
        va_end(args);
        if (n > 0) {
            String s(buf);
            _append(s);
        }
        return n > 0 ? n : 0;
    }

    void flush() { _flushTx(); }

private:
    void _append(const String& s) {
        bleTxBuffer += s;
        if (bleTxBuffer.length() >= 180 || bleTxBuffer.endsWith("\n")) {
            _flushTx();
        }
    }

    void _flushTx() {
        if (!bleDeviceConnected || !pTxCharacteristic) {
            bleTxBuffer = "";
            return;
        }
        // MTU协商后（185字节），单次notify可发送180字节数据
        // 一行CSV数据约35字节，一次notify即可完成传输
        const int CHUNK = 180;
        while (bleTxBuffer.length() > 0) {
            int chunkLen = min((int)bleTxBuffer.length(), CHUNK);
            pTxCharacteristic->setValue((uint8_t*)bleTxBuffer.c_str(), chunkLen);
            pTxCharacteristic->notify();
            if (bleTxBuffer.length() > chunkLen) {
                bleTxBuffer = bleTxBuffer.substring(chunkLen);
            } else {
                bleTxBuffer = "";
            }
        }
    }
};

BLESerialClass BLESerial;

// ========== MPU6050 配置 ==========
#define I2C_SDA        8
#define I2C_SCL        9
#define I2C_FREQ       400000
#define MPU_ADDR       0x68

const float mpu_target_hz = 200.0f;
const float alpha = 0.98f;

const float ACC_LSB_PER_G = 16384.0f;
const float GYR_LSB_PER_DPS = 131.0f;

#define MPU_PWR_MGMT_1  0x6B
#define MPU_SMPLRT_DIV  0x19
#define MPU_CONFIG      0x1A
#define MPU_GYRO_CONFIG 0x1B
#define MPU_ACCEL_CONFIG 0x1C
#define MPU_INT_ENABLE  0x38
#define MPU_ACCEL_XOUT_H 0x3B

int16_t ax_raw, ay_raw, az_raw, gx_raw, gy_raw, gz_raw;
float ax_g, ay_g, az_g, gx_dps, gy_dps, gz_dps;

float pitch_deg = 0.0f, roll_deg = 0.0f, yaw_deg = 0.0f;
float pitch_offset = 0.0f;
bool angles_initialized = false;

float gx_bias = 0, gy_bias = 0, gz_bias = 0;
uint32_t last_mpu_us = 0;

// ========== Flex Sensor 配置 ==========
int FLEX_PINS[FLEX_COUNT] = {
  10, // 大拇指4
  14, // 食指7
  18, // 中指
  4, // 无名指
  7  // 小拇指
};

const float ADC_MAX = 4095.0;
const float VREF = 3.3;

float voltageStraight[FLEX_COUNT];
float voltageBent[FLEX_COUNT];

bool calibrated = false;

// ========== 数据滤波与异常检测配置 ==========
const float FILTER_ALPHA = 0.7f;       // 一阶低通滤波系数 (0-1, 越大响应越快)
const float OUTLIER_THRESHOLD = 20.0f; // 异常值检测阈值（百分比变化超过此值视为异常）
float filteredBendPercent[FLEX_COUNT] = {0}; // 滤波后的弯曲百分比

// ========== 校准状态机 ==========
enum CalibState {
  CALIB_IDLE,
  CALIB_WAIT_START,
  CALIB_STEP1_COUNTDOWN,
  CALIB_STEP1_SAMPLING,
  CALIB_STEP2_COUNTDOWN,
  CALIB_STEP2_SAMPLING,
  CALIB_DONE
};
CalibState calibState = CALIB_IDLE;
unsigned long calibTimer = 0;
int calibCountdown = 0;
int calibStageDelay = 5000;
unsigned long lastWaitLogMs = 0;  // 上次输出等待提示的时间（避免日志刷屏）

int sampleFrequency = 50;
unsigned long sampleIntervalMs = 20;
unsigned long lastSampleMs = 0;

// ========== 函数声明 ==========
void waitSeconds(int sec);
void calibrateStraightAll();
void calibrateBentAll();
int getBendPercent(float voltage, int i);
int getBendLevel(int percent);
void handleBleCommand();
void startCalibration();
void updateCalibration();
void handleBleReconnect();

float normalize360(float a);
float normalize180(float a);
float angleDiff(float target, float current);
void mpuWrite(uint8_t reg, uint8_t data);
bool mpuReadBytes(uint8_t reg, uint8_t* buf, uint8_t len);
bool mpuReadAll();
bool mpuInit();
void calibrateGyro(uint16_t samples = 500);
float mapWristAngle(float angle_deg);

// ESP-NOW 函数声明
bool espnowInit();
void espnowOnRecvCb(const uint8_t* mac_addr, const uint8_t* data, int len);
uint16_t crc16Ccitt(const uint8_t* data, uint16_t length);
bool validateEspNowFrame(EspNowDataFrame* frame, int len);
void processRecvQueue();
void integrateAndForwardData();
void sendCalibCommand();

// ====================================================
// ESP-NOW 初始化
// ====================================================
bool espnowInit() {
  Serial.println("[ESPNOW] 初始化 ESP-NOW 接收...");
  
  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
  
  if (esp_now_init() != ESP_OK) {
    Serial.println("[ESPNOW] ESP-NOW 初始化失败");
    return false;
  }
  
  esp_now_register_recv_cb(espnowOnRecvCb);

  esp_now_set_pmk((uint8_t*)"ESPNOW_PMK_1234");

  // 添加 left 设备为 peer（用于发送校准指令）
  esp_now_peer_info_t peer_info = {};
  memcpy(peer_info.peer_addr, left_mac_addr, 6);
  peer_info.channel = ESPNOW_CHANNEL;
  peer_info.encrypt = false;
  if (esp_now_add_peer(&peer_info) != ESP_OK) {
    Serial.println("[ESPNOW] 添加left peer失败");
  }

  Serial.printf("[ESPNOW] 初始化成功，信道:%d\n", ESPNOW_CHANNEL);
  
  espnow_initialized = true;
  return true;
}

// ====================================================
// ESP-NOW 接收回调
// ====================================================
void espnowOnRecvCb(const uint8_t* mac_addr, const uint8_t* data, int len) {
  if (len != DATA_FRAME_SIZE) return;
  EspNowDataFrame* frame = (EspNowDataFrame*)data;

  // 基本帧校验
  if (frame->header != 0xAA || frame->tail != 0x55) return;

  // CRC 校验
  uint16_t calc_crc = crc16Ccitt((uint8_t*)frame, CRC_DATA_LENGTH);
  if (calc_crc != frame->crc) {
    Serial.printf("[ESPNOW] CRC校验失败，期望:0x%04X，计算:0x%04X\n", frame->crc, calc_crc);
    return;
  }

  // 就绪心跳包（left校准前定期发送，不入队）
  if (frame->data_type == READY_DATA_TYPE) {
    left_ready = true;
    left_ready_time = millis();
    Serial.println("[ESPNOW] 收到left就绪心跳");
    return;
  }

  // 传感器数据包（校验数据类型）
  if (frame->data_type != 0x01) {
    Serial.printf("[ESPNOW] 不支持的数据类型:%d\n", frame->data_type);
    return;
  }

  int next_tail = (recv_queue_tail + 1) % MAX_RECV_QUEUE_SIZE;
  if (next_tail == recv_queue_head) {
    Serial.println("[ESPNOW] 接收队列已满，丢弃最旧数据");
    recv_queue_head = (recv_queue_head + 1) % MAX_RECV_QUEUE_SIZE;
  }

  memcpy(&recv_queue[recv_queue_tail].frame, data, DATA_FRAME_SIZE);
  recv_queue[recv_queue_tail].recv_time = millis();
  recv_queue_tail = next_tail;

  Serial.printf("[ESPNOW] 数据帧校验通过，序号:%d\n", frame->seq_num);
}

// ====================================================
// CRC16-CCITT 校验计算
// ====================================================
uint16_t crc16Ccitt(const uint8_t* data, uint16_t length) {
  uint16_t crc = 0xFFFF;
  for (uint16_t i = 0; i < length; i++) {
    crc ^= (uint16_t)data[i] << 8;
    for (uint8_t j = 0; j < 8; j++) {
      crc = (crc << 1) ^ (crc & 0x8000 ? 0x1021 : 0);
    }
  }
  return crc;
}

// ====================================================
// ESP-NOW 数据帧校验
// ====================================================
bool validateEspNowFrame(EspNowDataFrame* frame, int len) {
  if (len != DATA_FRAME_SIZE) {
    Serial.printf("[ESPNOW] 长度校验失败，期望:%d，实际:%d\n", DATA_FRAME_SIZE, len);
    return false;
  }
  
  if (frame->header != 0xAA) {
    Serial.printf("[ESPNOW] 帧头校验失败，期望:0xAA，实际:0x%02X\n", frame->header);
    return false;
  }
  
  if (frame->tail != 0x55) {
    Serial.printf("[ESPNOW] 帧尾校验失败，期望:0x55，实际:0x%02X\n", frame->tail);
    return false;
  }
  
  if (frame->version != 1) {
    Serial.printf("[ESPNOW] 版本不兼容，当前版本:%d\n", frame->version);
    return false;
  }
  
  if (frame->data_type != 0x01) {
    Serial.printf("[ESPNOW] 数据类型不支持，类型:%d\n", frame->data_type);
    return false;
  }
  
  uint16_t calculated_crc = crc16Ccitt((uint8_t*)frame, CRC_DATA_LENGTH);
  if (calculated_crc != frame->crc) {
    Serial.printf("[ESPNOW] CRC校验失败，期望:0x%04X，计算:0x%04X\n", frame->crc, calculated_crc);
    return false;
  }
  
  return true;
}

// ====================================================
// 处理接收队列
// ====================================================
void processRecvQueue() {
  if (recv_queue_head == recv_queue_tail) {
    unsigned long now = millis();
    if (left_hand_data.valid && now - left_hand_data.update_time > RECV_TIMEOUT_MS) {
      Serial.println("[ESPNOW] left设备数据超时");
      left_hand_data.valid = false;
    }
    return;
  }
  
  EspNowDataFrame* frame = &recv_queue[recv_queue_head].frame;
  
  uint16_t seq_diff = frame->seq_num - last_recv_seq;
  if (seq_diff > 1 && last_recv_seq != 0) {
    Serial.printf("[ESPNOW] 检测到丢包，丢失:%d个包\n", seq_diff - 1);
  }
  last_recv_seq = frame->seq_num;
  
  left_hand_data.thumb = frame->thumb / 100.0f;
  left_hand_data.index = frame->index / 100.0f;
  left_hand_data.middle = frame->middle / 100.0f;
  left_hand_data.ring = frame->ring / 100.0f;
  left_hand_data.pinky = frame->pinky / 100.0f;
  left_hand_data.wrist = frame->wrist / 1000.0f;
  left_hand_data.update_time = millis();
  left_hand_data.valid = true;
  
  recv_queue_head = (recv_queue_head + 1) % MAX_RECV_QUEUE_SIZE;
}

// ====================================================
// 数据整合与转发
// CSV格式：L_thumb,L_index,L_middle,L_ring,L_pinky,L_wrist,R_thumb,R_index,R_middle,R_ring,R_pinky,R_wrist
// 示例：95,90,88,92,87,20,50,45,40,48,55,-15
// ====================================================
void integrateAndForwardData() {
  if (!left_hand_data.valid || !right_hand_data.valid) {
    return;
  }
  
  if (bleDeviceConnected) {
    BLESerial.printf("%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d\n",
               (int)(left_hand_data.thumb * 100),
               (int)(left_hand_data.index * 100),
               (int)(left_hand_data.middle * 100),
               (int)(left_hand_data.ring * 100),
               (int)(left_hand_data.pinky * 100),
               (int)(left_hand_data.wrist * 100),
               (int)(right_hand_data.thumb * 100),
               (int)(right_hand_data.index * 100),
               (int)(right_hand_data.middle * 100),
               (int)(right_hand_data.ring * 100),
               (int)(right_hand_data.pinky * 100),
               (int)(right_hand_data.wrist * 100));
    BLESerial.flush();
  }
}

// ====================================================
// 发送校准指令给 left 设备（同步触发双手校准）
// 复用 EspNowDataFrame，data_type=0x02 表示校准指令
// ====================================================
void sendCalibCommand() {
  EspNowDataFrame frame = {
    .header = 0xAA,
    .version = 1,
    .data_type = CALIB_CMD_DATA_TYPE,
    .thumb = 0, .index = 0, .middle = 0, .ring = 0, .pinky = 0,
    .wrist = 0,
    .seq_num = 0,
    .crc = 0,
    .tail = 0x55
  };
  frame.crc = crc16Ccitt((uint8_t*)&frame, CRC_DATA_LENGTH);

  esp_err_t result = esp_now_send(left_mac_addr, (uint8_t*)&frame, DATA_FRAME_SIZE);
  Serial.printf("[ESPNOW] 已发送校准指令给left，结果:%d\n", result);
}

// ====================================================
// 蓝牙重连处理
// ====================================================
void handleBleReconnect() {
  if (bleDeviceConnected) return;
  
  unsigned long now = millis();
  if (now - bleDisconnectTime >= BLE_RECONNECT_INTERVAL) {
    Serial.println("[BLE] 尝试重新广播...");
    BLEDevice::startAdvertising();
    bleDisconnectTime = now;
  }
}

// ====================================================
// 初始化
// ====================================================
void setup() {
  Serial.begin(115200);
  Serial.setTimeout(20);

  analogReadResolution(12);
  analogSetAttenuation(ADC_11db);

  Serial.println("==== Right设备启动 ====");
  
  WiFi.mode(WIFI_STA);
  Serial.print("本设备MAC地址: ");
  Serial.println(WiFi.macAddress());
  WiFi.disconnect();

  // ========== ESP-NOW 初始化 ==========
  if (!espnowInit()) {
    Serial.println("[ESPNOW] ESP-NOW初始化失败，系统继续运行");
  }

  // ========== BLE 初始化 ==========
  Serial.println("初始化 BLE (Nordic UART Service)...");
  BLESerial.begin("right");
  BLESerial.setTimeout(20);
  Serial.println("BLE 已启动，设备名: right，等待连接...");

  // ========== MPU6050 初始化 ==========
  Serial.println("初始化 MPU6050...");
  Wire.begin(I2C_SDA, I2C_SCL, I2C_FREQ);
  delay(50);

  if (!mpuInit()) {
    Serial.println("MPU6050 init failed.");
    while (1) { delay(500); }
  }
  Serial.println("MPU6050 init OK.");

  Serial.println("校准陀螺仪...");
  calibrateGyro(600);
  Serial.printf("Gyro bias: %.2f, %.2f, %.2f (LSB)\n", gx_bias, gy_bias, gz_bias);

  if (mpuReadAll()) {
    ax_g = ax_raw / ACC_LSB_PER_G;
    ay_g = ay_raw / ACC_LSB_PER_G;
    az_g = az_raw / ACC_LSB_PER_G;

    float rollAcc = atan2f(ay_g, az_g) * 180.0f / PI;
    float pitchAcc = atan2f(-ax_g, sqrtf(ay_g*ay_g + az_g*az_g)) * 180.0f / PI;

    roll_deg = normalize180(rollAcc);
    pitch_deg = normalize180(pitchAcc);
    pitch_offset = pitch_deg;
    angles_initialized = true;
  }

  last_mpu_us = micros();
  Serial.println("MPU6050 校准完成！");

  // ========== Flex Sensor 初始化 ==========
  Serial.println("准备就绪，等待校准指令...");
  Serial.println("BLE 指令: CALIBRATE -> 开始校准, FREQ:<1-100> -> 设置频率");

  for (int i = 0; i < FLEX_COUNT; i++) {
    voltageStraight[i] = -99.0;
    voltageBent[i] = 99.0;
  }

  // 进入等待状态：仅当 ESPNOW 收到 left 数据 且 BLE 连接到网页 时才开始校准
  calibState = CALIB_WAIT_START;
  Serial.println("等待 left 设备(ESPNOW)与网页(BLE)均连接后开始校准...");
}

// ====================================================
// 主循环：实时处理数据
// ====================================================
void loop() {
  // ========== 处理蓝牙重连 ==========
  handleBleReconnect();

  // ========== 处理 ESP-NOW 接收队列 ==========
  processRecvQueue();

  // ========== 处理 BLE 指令 ==========
  handleBleCommand();

  // ========== 校准状态机 ==========
  if (!calibrated) {
    updateCalibration();
    return;
  }

  // ========== MPU6050 更新（每帧）==========
  uint32_t now_us = micros();
  float dt = (now_us - last_mpu_us) / 1e6f;
  if (dt <= 0) dt = 1.0f / mpu_target_hz;
  last_mpu_us = now_us;

  if (mpuReadAll()) {
    ax_g = ax_raw / ACC_LSB_PER_G;
    ay_g = ay_raw / ACC_LSB_PER_G;
    az_g = az_raw / ACC_LSB_PER_G;

    gx_dps = (gx_raw - gx_bias) / GYR_LSB_PER_DPS;
    gy_dps = (gy_raw - gy_bias) / GYR_LSB_PER_DPS;
    gz_dps = (gz_raw - gz_bias) / GYR_LSB_PER_DPS;

    float rollAcc = atan2f(ay_g, az_g) * 180.0f / PI;
    float pitchAcc = atan2f(-ax_g, sqrtf(ay_g*ay_g + az_g*az_g)) * 180.0f / PI;

    if (!angles_initialized) {
      roll_deg = normalize180(rollAcc);
      pitch_deg = normalize180(pitchAcc);
      yaw_deg = 0.0f;
      angles_initialized = true;
    } else {
      float roll_gyro = roll_deg + gx_dps * dt;
      float pitch_gyro = pitch_deg + gy_dps * dt;

      float roll_err = angleDiff(rollAcc, roll_gyro);
      float pitch_err = angleDiff(pitchAcc, pitch_gyro);

      roll_deg = normalize180(roll_gyro + (1.0f - alpha) * roll_err);
      pitch_deg = normalize180(pitch_gyro + (1.0f - alpha) * pitch_err);
      yaw_deg = normalize180(yaw_deg + gz_dps * dt);
    }
  }

  // ========== Flex Sensor 采样（按频率）==========
  unsigned long now_ms = millis();
  if (now_ms - lastSampleMs < sampleIntervalMs) return;
  lastSampleMs = now_ms;

  int bendPercent[FLEX_COUNT];

  for (int i = 0; i < FLEX_COUNT; i++) {
    int rawValue = analogRead(FLEX_PINS[i]);
    float volt = rawValue / ADC_MAX * VREF;
    bendPercent[i] = getBendPercent(volt, i);
  }

  // ========== 数据滤波与异常值检测 ==========
  for (int i = 0; i < FLEX_COUNT; i++) {
    int rawPercent = bendPercent[i];
    
    float diff = abs(rawPercent - filteredBendPercent[i]);
    if (diff > OUTLIER_THRESHOLD && calibrated) {
      bendPercent[i] = (int)filteredBendPercent[i];
    } else {
      filteredBendPercent[i] = FILTER_ALPHA * rawPercent + (1.0f - FILTER_ALPHA) * filteredBendPercent[i];
      bendPercent[i] = (int)(filteredBendPercent[i] + 0.5f);
    }
  }

  // ========== 更新right设备本地数据缓存 ==========
  float wrist_val = mapWristAngle(pitch_deg);
  
  right_hand_data.thumb = bendPercent[0] / 100.0f;
  right_hand_data.index = bendPercent[1] / 100.0f;
  right_hand_data.middle = bendPercent[2] / 100.0f;
  right_hand_data.ring = bendPercent[3] / 100.0f;
  right_hand_data.pinky = bendPercent[4] / 100.0f;
  right_hand_data.wrist = wrist_val;
  right_hand_data.update_time = millis();
  right_hand_data.valid = true;

  // ========== 整合并转发数据 ==========
  integrateAndForwardData();

  // ========== USB Serial 调试输出 ==========
  Serial.printf("{\"left_thumb\":%.3f,\"left_index\":%.3f,\"left_middle\":%.3f,\"left_ring\":%.3f,\"left_pinky\":%.3f,\"left_wrist\":%.3f,\"right_thumb\":%.3f,\"right_index\":%.3f,\"right_middle\":%.3f,\"right_ring\":%.3f,\"right_pinky\":%.3f,\"right_wrist\":%.3f}\n",
               left_hand_data.thumb, left_hand_data.index, left_hand_data.middle,
               left_hand_data.ring, left_hand_data.pinky, left_hand_data.wrist,
               right_hand_data.thumb, right_hand_data.index, right_hand_data.middle,
               right_hand_data.ring, right_hand_data.pinky, right_hand_data.wrist);
}

// ====================================================
// MPU6050 辅助函数
// ====================================================
float normalize360(float a) {
  a = fmodf(a, 360.0f);
  if (a < 0) a += 360.0f;
  return a;
}

float normalize180(float a) {
  a = fmodf(a + 180.0f, 360.0f);
  if (a < 0) a += 360.0f;
  return a - 180.0f;
}

float angleDiff(float target, float current) {
  return normalize180(target - current);
}

void mpuWrite(uint8_t reg, uint8_t data) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(reg);
  Wire.write(data);
  Wire.endTransmission();
}

bool mpuReadBytes(uint8_t reg, uint8_t* buf, uint8_t len) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return false;
  uint8_t n = Wire.requestFrom((uint8_t)MPU_ADDR, (uint8_t)len);
  if (n != len) return false;
  for (uint8_t i = 0; i < len; i++) {
    buf[i] = Wire.read();
  }
  return true;
}

bool mpuReadAll() {
  uint8_t buf[14];
  if (!mpuReadBytes(MPU_ACCEL_XOUT_H, buf, 14)) return false;
  ay_raw = (int16_t)((buf[0] << 8) | buf[1]);
  ax_raw = (int16_t)((buf[2] << 8) | buf[3]);
  az_raw = (int16_t)((buf[4] << 8) | buf[5]);
  gy_raw = (int16_t)((buf[8] << 8) | buf[9]);
  gx_raw = (int16_t)((buf[10] << 8) | buf[11]);
  gz_raw = (int16_t)((buf[12] << 8) | buf[13]);
  return true;
}

bool mpuInit() {
  mpuWrite(MPU_PWR_MGMT_1, 0x01);
  delay(100);

  mpuWrite(MPU_CONFIG, 0x03);
  mpuWrite(MPU_SMPLRT_DIV, 9);
  mpuWrite(MPU_GYRO_CONFIG, 0x00);
  mpuWrite(MPU_ACCEL_CONFIG, 0x00);
  mpuWrite(MPU_INT_ENABLE, 0x00);

  return mpuReadAll();
}

void calibrateGyro(uint16_t samples) {
  gx_bias = gy_bias = gz_bias = 0;
  for (uint16_t i = 0; i < samples; i++) {
    if (mpuReadAll()) {
      gx_bias += gx_raw;
      gy_bias += gy_raw;
      gz_bias += gz_raw;
    }
    delay(2);
  }
  gx_bias /= samples;
  gy_bias /= samples;
  gz_bias /= samples;
}

float mapWristAngle(float angle_deg) {
  float centered = -(angle_deg - pitch_offset);
  float rad = centered * PI / 180.0f;
  float mapped = constrain(rad, -0.4f, 0.4f);
  return mapped;
}

// ====================================================
// Flex Sensor 辅助函数
// ====================================================
void waitSeconds(int sec) {
  for (int i = sec; i >= 1; i--) {
    Serial.print("倒计时：");
    Serial.print(i);
    Serial.println(" 秒");
    if (bleDeviceConnected) {
      BLESerial.printf("校准:倒计时:%d\n", i);
      BLESerial.flush();
    }
    delay(1000);
  }
}

void calibrateStraightAll() {
  unsigned long start = millis();

  Serial.println();
  Serial.println("=== 校准:伸直 === 请保持五指【伸直】（采集 2 秒）===");
  if (bleDeviceConnected) {
    BLESerial.println("校准:伸直");
    BLESerial.flush();
  }
  delay(300);

  while (millis() - start < 2000) {
    for (int i = 0; i < FLEX_COUNT; i++) {
      float v = analogRead(FLEX_PINS[i]) * VREF / ADC_MAX;
      if (v > voltageStraight[i]) voltageStraight[i] = v;
    }
    delay(10);
  }

  Serial.println("伸直电压（max）：");
  if (bleDeviceConnected) {
    BLESerial.printf("校准:伸直完成:%.3f,%.3f,%.3f,%.3f,%.3f\n",
      voltageStraight[0], voltageStraight[1], voltageStraight[2],
      voltageStraight[3], voltageStraight[4]);
    BLESerial.flush();
  }
  for (int i = 0; i < FLEX_COUNT; i++) {
    Serial.print("CH");
    Serial.print(i);
    Serial.print(": ");
    Serial.println(voltageStraight[i], 3);
  }
}

void calibrateBentAll() {
  unsigned long start = millis();

  Serial.println();
  Serial.println("=== 校准:弯曲 === 请将五指【最大弯曲】（采集 2 秒）===");
  if (bleDeviceConnected) {
    BLESerial.println("校准:弯曲");
    BLESerial.flush();
  }
  delay(300);

  while (millis() - start < 2000) {
    for (int i = 0; i < FLEX_COUNT; i++) {
      float v = analogRead(FLEX_PINS[i]) * VREF / ADC_MAX;
      if (v < voltageBent[i]) voltageBent[i] = v;
    }
    delay(10);
  }

  Serial.println("弯曲电压（min）：");
  if (bleDeviceConnected) {
    BLESerial.printf("校准:弯曲完成:%.3f,%.3f,%.3f,%.3f,%.3f\n",
      voltageBent[0], voltageBent[1], voltageBent[2],
      voltageBent[3], voltageBent[4]);
    BLESerial.flush();
  }
  for (int i = 0; i < FLEX_COUNT; i++) {
    Serial.print("CH");
    Serial.print(i);
    Serial.print(": ");
    Serial.println(voltageBent[i], 3);
  }
}

int getBendPercent(float voltage, int i) {
  float vS = voltageStraight[i];
  float vB = voltageBent[i];

  if (fabs(vS - vB) < 0.01) return 0;

  float p = (vS - voltage) * 100.0 / (vS - vB);
  p = constrain(p, 0, 100);
  return (int)(p + 0.5);
}

int getBendLevel(int percent) {
  return constrain(percent, 0, 100);
}

// ====================================================
// BLE 指令处理
// ====================================================
void handleBleCommand() {
  if (!BLESerial.available()) return;

  String cmd = BLESerial.readStringUntil('\n');
  cmd.trim();

  if (cmd.length() == 0) return;

  Serial.printf("收到 BLE 指令: %s\n", cmd.c_str());

  if (cmd.startsWith("FREQ:")) {
    String freqStr = cmd.substring(5);
    int freq = freqStr.toInt();

    if (freq >= 1 && freq <= 100) {
      sampleFrequency = freq;
      sampleIntervalMs = 1000 / sampleFrequency;
      Serial.printf("采样频率已设置为 %d Hz（间隔 %lu ms）\n", sampleFrequency, sampleIntervalMs);
      BLESerial.printf("OK:FREQ=%d\n", sampleFrequency);
      BLESerial.flush();
    } else {
      BLESerial.println("ERR:FREQ_OUT_OF_RANGE");
      BLESerial.flush();
    }
  } else if (cmd == "CALIBRATE") {
    startCalibration();
  } else {
    BLESerial.println("ERR:UNKNOWN_CMD");
    BLESerial.flush();
  }
}

// ====================================================
// 校准状态机
// ====================================================
void startCalibration() {
  if (calibrated) {
    calibrated = false;
    for (int i = 0; i < FLEX_COUNT; i++) {
      voltageStraight[i] = -99.0;
      voltageBent[i] = 99.0;
    }
  }

  Serial.println();
  Serial.println("==== 开始校准流程 ====");
  if (bleDeviceConnected) {
    BLESerial.println("校准:开始");
    BLESerial.flush();
  }

  // 通过 ESPNOW 同步触发 left 设备校准（双手同步）
  sendCalibCommand();

  calibState = CALIB_STEP1_COUNTDOWN;
  calibCountdown = 5;
  calibTimer = millis();
}

void updateCalibration() {
  unsigned long now = millis();

  switch (calibState) {
    case CALIB_WAIT_START:
      // left 就绪心跳超时检测（3秒未收到则视为离线）
      if (left_ready && now - left_ready_time > 3000) {
        left_ready = false;
        Serial.println("[ESPNOW] left就绪心跳超时，视为离线");
      }
      // 仅当 BLE 连接网页 且 left 设备在线（收到就绪心跳）时才开始校准
      if (bleDeviceConnected && left_ready) {
        startCalibration();
      } else {
        // 间隔 2 秒输出一次等待状态，避免日志刷屏
        if (now - lastWaitLogMs >= 2000) {
          lastWaitLogMs = now;
          Serial.printf("[WAIT] 等待校准条件: BLE=%s, left在线=%s\n",
                        bleDeviceConnected ? "已连接" : "未连接",
                        left_ready ? "是" : "否");
          if (bleDeviceConnected) {
            BLESerial.printf("[WAIT] 等待left设备就绪...\n");
            BLESerial.flush();
          }
        }
      }
      break;

    case CALIB_STEP1_COUNTDOWN:
      if (now - calibTimer >= 1000) {
        calibTimer = now;
        calibCountdown--;
        Serial.printf("倒计时：%d 秒\n", calibCountdown);
        if (bleDeviceConnected) {
          BLESerial.printf("校准:倒计时:%d\n", calibCountdown);
          BLESerial.flush();
        }
        if (calibCountdown <= 0) {
          calibState = CALIB_STEP1_SAMPLING;
          calibTimer = now;
        }
      }
      break;

    case CALIB_STEP1_SAMPLING:
      {
        Serial.println();
        Serial.println("=== 校准:伸直 === 请保持五指【伸直】（采集 2 秒）===");
        if (bleDeviceConnected) {
          BLESerial.println("校准:伸直");
          BLESerial.flush();
        }

        unsigned long start = now;
        while (millis() - start < 2000) {
          for (int i = 0; i < FLEX_COUNT; i++) {
            float v = analogRead(FLEX_PINS[i]) * VREF / ADC_MAX;
            if (v > voltageStraight[i]) voltageStraight[i] = v;
          }
          delay(10);
        }

        Serial.println("伸直电压（max）：");
        if (bleDeviceConnected) {
          BLESerial.printf("校准:伸直完成:%.3f,%.3f,%.3f,%.3f,%.3f\n",
            voltageStraight[0], voltageStraight[1], voltageStraight[2],
            voltageStraight[3], voltageStraight[4]);
          BLESerial.flush();
        }
        for (int i = 0; i < FLEX_COUNT; i++) {
          Serial.print("CH"); Serial.print(i); Serial.print(": ");
          Serial.println(voltageStraight[i], 3);
        }

        calibState = CALIB_STEP2_COUNTDOWN;
        calibCountdown = 5;
        calibTimer = millis();
      }
      break;

    case CALIB_STEP2_COUNTDOWN:
      if (now - calibTimer >= 1000) {
        calibTimer = now;
        calibCountdown--;
        Serial.printf("倒计时：%d 秒\n", calibCountdown);
        if (bleDeviceConnected) {
          BLESerial.printf("校准:倒计时:%d\n", calibCountdown);
          BLESerial.flush();
        }
        if (calibCountdown <= 0) {
          calibState = CALIB_STEP2_SAMPLING;
          calibTimer = now;
        }
      }
      break;

    case CALIB_STEP2_SAMPLING:
      {
        Serial.println();
        Serial.println("=== 校准:弯曲 === 请将五指【最大弯曲】（采集 2 秒）===");
        if (bleDeviceConnected) {
          BLESerial.println("校准:弯曲");
          BLESerial.flush();
        }

        unsigned long start = now;
        while (millis() - start < 2000) {
          for (int i = 0; i < FLEX_COUNT; i++) {
            float v = analogRead(FLEX_PINS[i]) * VREF / ADC_MAX;
            if (v < voltageBent[i]) voltageBent[i] = v;
          }
          delay(10);
        }

        Serial.println("弯曲电压（min）：");
        if (bleDeviceConnected) {
          BLESerial.printf("校准:弯曲完成:%.3f,%.3f,%.3f,%.3f,%.3f\n",
            voltageBent[0], voltageBent[1], voltageBent[2],
            voltageBent[3], voltageBent[4]);
          BLESerial.flush();
        }
        for (int i = 0; i < FLEX_COUNT; i++) {
          Serial.print("CH"); Serial.print(i); Serial.print(": ");
          Serial.println(voltageBent[i], 3);
        }

        calibState = CALIB_DONE;
        calibTimer = now;
      }
      break;

    case CALIB_DONE:
      Serial.println();
      Serial.println("==== 校准完成！进入实时识别模式 ====");
      Serial.println("CSV格式: L_thumb,L_index,L_middle,L_ring,L_pinky,L_wrist,R_thumb,R_index,R_middle,R_ring,R_pinky,R_wrist");
      Serial.println("指令格式(BLE): FREQ:<1-100>, CALIBRATE");
      if (bleDeviceConnected) {
        BLESerial.println("校准:完成");
        BLESerial.flush();
      }
      calibrated = true;
      calibState = CALIB_IDLE;
      break;

    default:
      break;
  }
}