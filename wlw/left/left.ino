/*
 * Flex Sensor 5-Channel + MPU6050 Gesture Recognition - Left Device
 * 
 * 功能：采集传感器数据并通过ESP-NOW发送至right设备
 * 
 * ESP-NOW 数据传输协议格式：
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
 * 数据传输流程图：
 * 传感器采样 → 数据格式化 → 加入发送队列 → ESP-NOW发送 → 发送回调处理
 *     ↑                          |
 *     |                          ↓
 *     └────────── 重发机制(最多3次) ← 发送失败
 * 
 * 串口指令：
 * FREQ:10   -> 设置采样频率为 10 Hz
 * FREQ:20   -> 设置采样频率为 20 Hz
 * FREQ:50   -> 设置采样频率为 50 Hz
 * FREQ:100  -> 设置采样频率为 100 Hz
 */

#include <Arduino.h>
#include <math.h>
#include <Wire.h>
#include <esp_now.h>
#include <esp_wifi.h>
#include <WiFi.h>

#define FLEX_COUNT 5

// ========== ESP-NOW 配置 ==========
#define ESPNOW_CHANNEL    1     // ESPNOW信道（需与right设备一致）
#define MAX_RETRY_COUNT   3     // 最大重发次数
#define SEND_QUEUE_SIZE   16    // 发送队列大小（增大以支持更高采样频率）
#define DATA_RATE_HZ      50    // 数据传输速率（Hz）
#define CALIB_CMD_DATA_TYPE 0x02  // 校准指令数据类型（由right设备同步触发）
#define READY_DATA_TYPE    0x03  // 就绪心跳数据类型（校准前定期发送，通知right本设备已在线）

// Right设备MAC地址
uint8_t right_mac_addr[] = {0x50, 0x78, 0x7D, 0x15, 0xA6, 0x44};

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

// ========== ESP-NOW 发送队列 ==========
typedef struct {
    EspNowDataFrame frame;
    uint8_t retry_count;
    unsigned long send_time;
    bool sending;          // 是否正在发送中（已提交，等待回调），防止重复发送
} SendQueueItem;

SendQueueItem send_queue[SEND_QUEUE_SIZE];
int queue_head = 0;
int queue_tail = 0;
uint16_t packet_seq_num = 0;
bool espnow_initialized = false;
volatile bool calibRequested = false;  // 收到right设备校准指令标志（中断回调中置位）

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
float roll_offset = 0.0f;   // 初始姿态偏移（手腕零点，使用roll轴）
bool angles_initialized = false;

float gx_bias = 0, gy_bias = 0, gz_bias = 0;
uint32_t last_mpu_us = 0;

// ========== Flex Sensor 配置 ==========
int FLEX_PINS[FLEX_COUNT] = {
  14, // 大拇指
  10, // 食指
  18, // 中指
  7, // 无名指
  4  // 小拇指
};

const float ADC_MAX = 4095.0;
const float VREF = 3.3;

float voltageStraight[FLEX_COUNT];
float voltageBent[FLEX_COUNT];

bool calibrated = false;

int sampleFrequency = 50;
unsigned long sampleIntervalMs = 20;
unsigned long lastSampleMs = 0;

// ========== 数据滤波与异常检测配置 ==========
const float FILTER_ALPHA = 0.7f;       // 一阶低通滤波系数 (0-1, 越大响应越快)
const float OUTLIER_THRESHOLD = 20.0f; // 异常值检测阈值（百分比变化超过此值视为异常）
float filteredBendPercent[FLEX_COUNT] = {0}; // 滤波后的弯曲百分比

// ========== 函数声明 ==========
void waitSeconds(int sec);
void calibrateStraightAll();
void calibrateBentAll();
int getBendPercent(float voltage, int i);
int getBendLevel(int percent);
void handleSerialCommand();

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
void espnowOnSendCb(const uint8_t* mac_addr, esp_now_send_status_t status);
void espnowOnRecvCb(const uint8_t* mac_addr, const uint8_t* data, int len);
uint16_t crc16Ccitt(const uint8_t* data, uint16_t length);
bool espnowSendData(EspNowDataFrame* frame);
bool enqueueSendData(EspNowDataFrame* frame);
void processSendQueue();
void runCalibration();

// ====================================================
// ESP-NOW 初始化
// ====================================================
bool espnowInit() {
  Serial.println("[ESPNOW] 初始化 ESP-NOW...");
  
  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
  
  if (esp_now_init() != ESP_OK) {
    Serial.println("[ESPNOW] ESP-NOW 初始化失败");
    return false;
  }
  
  esp_now_register_send_cb(espnowOnSendCb);
  esp_now_register_recv_cb(espnowOnRecvCb);  // 接收right设备的校准指令
  
  esp_now_peer_info_t peer_info = {};
  memcpy(peer_info.peer_addr, right_mac_addr, 6);
  peer_info.channel = ESPNOW_CHANNEL;
  peer_info.encrypt = false;
  
  if (esp_now_add_peer(&peer_info) != ESP_OK) {
    Serial.println("[ESPNOW] 添加peer失败");
    return false;
  }
  
  Serial.printf("[ESPNOW] 初始化成功，信道:%d，目标MAC:", ESPNOW_CHANNEL);
  for (int i = 0; i < 6; i++) {
    Serial.printf("%02X", right_mac_addr[i]);
    if (i < 5) Serial.print(":");
  }
  Serial.println();
  
  espnow_initialized = true;
  return true;
}

// ====================================================
// ESP-NOW 发送回调
// ====================================================
void espnowOnSendCb(const uint8_t* mac_addr, esp_now_send_status_t status) {
  if (queue_head == queue_tail) {
    return;
  }

  SendQueueItem* item = &send_queue[queue_head];
  uint16_t current_seq = item->frame.seq_num;
  item->sending = false;   // 回调已返回，清除发送中标志

  if (status == ESP_NOW_SEND_SUCCESS) {
    Serial.printf("[ESPNOW] 发送成功，序号:%d\n", current_seq);
    queue_head = (queue_head + 1) % SEND_QUEUE_SIZE;
  } else {
    Serial.printf("[ESPNOW] 发送失败，序号:%d，状态:%d\n", current_seq, status);

    item->retry_count++;
    if (item->retry_count <= MAX_RETRY_COUNT) {
      Serial.printf("[ESPNOW] 准备重发，重试次数:%d\n", item->retry_count);
      // 重发由 processSendQueue 在 50ms 间隔后执行
    } else {
      Serial.printf("[ESPNOW] 重发次数耗尽(%d次)，丢弃数据包\n", MAX_RETRY_COUNT);
      queue_head = (queue_head + 1) % SEND_QUEUE_SIZE;
    }
  }
}

// ====================================================
// ESP-NOW 接收回调（处理 right 设备的校准指令）
// ====================================================
void espnowOnRecvCb(const uint8_t* mac_addr, const uint8_t* data, int len) {
  if (len != DATA_FRAME_SIZE) return;
  EspNowDataFrame* frame = (EspNowDataFrame*)data;

  // 基本帧校验
  if (frame->header != 0xAA || frame->tail != 0x55) return;

  // CRC 校验
  uint16_t calc_crc = crc16Ccitt((uint8_t*)frame, CRC_DATA_LENGTH);
  if (calc_crc != frame->crc) {
    Serial.printf("[ESPNOW] 校准指令CRC校验失败，期望:0x%04X，计算:0x%04X\n", frame->crc, calc_crc);
    return;
  }

  // 校准指令
  if (frame->data_type == CALIB_CMD_DATA_TYPE) {
    calibRequested = true;
    Serial.println("[ESPNOW] 收到right设备校准指令，准备同步校准");
  }
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
// ESP-NOW 发送数据
// ====================================================
bool espnowSendData(EspNowDataFrame* frame) {
  if (!espnow_initialized) {
    Serial.println("[ESPNOW] ESP-NOW未初始化");
    return false;
  }
  
  esp_err_t result = esp_now_send(right_mac_addr, (uint8_t*)frame, DATA_FRAME_SIZE);
  
  if (result == ESP_OK) {
    return true;
  } else {
    Serial.printf("[ESPNOW] esp_now_send失败，错误码:%d\n", result);
    return false;
  }
}

// ====================================================
// 入队发送数据
// ====================================================
bool enqueueSendData(EspNowDataFrame* frame) {
  int next_tail = (queue_tail + 1) % SEND_QUEUE_SIZE;
  
  if (next_tail == queue_head) {
    Serial.println("[ESPNOW] 发送队列已满，丢弃数据包");
    return false;
  }
  
  send_queue[queue_tail].frame = *frame;
  send_queue[queue_tail].retry_count = 0;
  send_queue[queue_tail].send_time = millis();
  send_queue[queue_tail].sending = false;
  queue_tail = next_tail;
  
  return true;
}

// ====================================================
// 处理发送队列
// ====================================================
void processSendQueue() {
  if (queue_head == queue_tail) {
    return;
  }

  SendQueueItem* item = &send_queue[queue_head];

  // 队首包正在发送中（已提交，等待回调），跳过避免重复发送
  if (item->sending) {
    return;
  }

  if (item->retry_count == 0) {
    // 首次发送
    Serial.printf("[ESPNOW] 发送数据包，序号:%d\n", item->frame.seq_num);
    item->sending = true;
    item->send_time = millis();
    if (!espnowSendData(&item->frame)) {
      // 提交失败，回调不会触发，需手动清除 sending 标志，等待下次重试
      item->sending = false;
    }
  } else {
    // 重发：等待 50ms 间隔
    unsigned long now = millis();
    if (now - item->send_time > 50) {
      Serial.printf("[ESPNOW] 重发数据包，序号:%d，重试次数:%d\n",
                   item->frame.seq_num, item->retry_count);
      item->sending = true;
      item->send_time = now;
      if (!espnowSendData(&item->frame)) {
        item->sending = false;
      }
    }
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

  Serial.println("==== Left设备启动 ====");
  
  WiFi.mode(WIFI_STA);
  Serial.print("本设备MAC地址: ");
  Serial.println(WiFi.macAddress());
  WiFi.disconnect();

  // ========== ESP-NOW 初始化 ==========
  if (!espnowInit()) {
    Serial.println("[ESPNOW] ESP-NOW初始化失败，系统继续运行");
  }

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
    roll_offset = roll_deg;  // 记录初始姿态作为手腕零点（X轴）
    angles_initialized = true;
  }

  last_mpu_us = micros();
  Serial.println("MPU6050 校准完成！");

  // ========== Flex Sensor 初始化 ==========
  // 不再开机自动校准，等待 right 设备通过 ESPNOW 发送校准指令后同步校准
  for (int i = 0; i < FLEX_COUNT; i++) {
    voltageStraight[i] = -99.0;
    voltageBent[i] = 99.0;
  }

  Serial.println("==== Left设备就绪 ====");
  Serial.println("等待 right 设备发送校准指令以同步校准...");
}

// ====================================================
// 执行 Flex Sensor 校准流程（由 right 设备通过 ESPNOW 同步触发）
// 时序与 right 设备一致：5秒倒计时 → 伸直采样2秒 → 5秒倒计时 → 弯曲采样2秒
// ====================================================
void runCalibration() {
  Serial.println();
  Serial.println("==== Left设备开始同步校准 ====");

  for (int i = 0; i < FLEX_COUNT; i++) {
    voltageStraight[i] = -99.0;
    voltageBent[i] = 99.0;
  }

  waitSeconds(5);

  Serial.println();
  Serial.println("=== Step 1: 请保持五指【伸直】（采集 2 秒）===");
  delay(300);
  calibrateStraightAll();

  Serial.println("伸直电压（max）：");
  for (int i = 0; i < FLEX_COUNT; i++) {
    Serial.print("CH");
    Serial.print(i);
    Serial.print(": ");
    Serial.println(voltageStraight[i], 3);
  }

  waitSeconds(5);

  Serial.println();
  Serial.println("=== Step 2: 请将五指【最大弯曲】（采集 2 秒）===");
  delay(300);
  calibrateBentAll();

  Serial.println("弯曲电压（min）：");
  for (int i = 0; i < FLEX_COUNT; i++) {
    Serial.print("CH");
    Serial.print(i);
    Serial.print(": ");
    Serial.println(voltageBent[i], 3);
  }

  Serial.println();
  Serial.println("==== Left设备校准完成！进入实时识别模式 ====");
  calibrated = true;
}

// ====================================================
// 主循环：实时采集并发送数据
// ====================================================
void loop() {
  // ========== 处理发送队列 ==========
  processSendQueue();

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
  // 校准前等待 right 设备通过 ESPNOW 发送的校准指令
  if (!calibrated) {
    // 定期发送就绪心跳，通知 right 设备本设备已在线（每秒一次）
    unsigned long now_ms = millis();
    if (now_ms - lastSampleMs >= 1000) {
      lastSampleMs = now_ms;
      EspNowDataFrame readyFrame = {
        .header = 0xAA,
        .version = 1,
        .data_type = READY_DATA_TYPE,
        .thumb = 0, .index = 0, .middle = 0, .ring = 0, .pinky = 0,
        .wrist = 0,
        .seq_num = ++packet_seq_num,
        .crc = 0,
        .tail = 0x55
      };
      readyFrame.crc = crc16Ccitt((uint8_t*)&readyFrame, CRC_DATA_LENGTH);
      enqueueSendData(&readyFrame);
    }
    // 收到校准指令则执行同步校准
    if (calibRequested) {
      calibRequested = false;
      runCalibration();
    }
    return;
  }

  handleSerialCommand();

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
    
    // 异常值检测：如果当前值与滤波值差异超过阈值，保留上次滤波值
    float diff = abs(rawPercent - filteredBendPercent[i]);
    if (diff > OUTLIER_THRESHOLD && calibrated) {
      // 异常值，保持上次滤波值不变
      bendPercent[i] = (int)filteredBendPercent[i];
    } else {
      // 正常数据，应用一阶低通滤波
      filteredBendPercent[i] = FILTER_ALPHA * rawPercent + (1.0f - FILTER_ALPHA) * filteredBendPercent[i];
      bendPercent[i] = (int)(filteredBendPercent[i] + 0.5f);
    }
  }

  // ========== 构建ESP-NOW数据包并发送 ==========
  float wrist_val = mapWristAngle(roll_deg);

  EspNowDataFrame frame = {
    .header = 0xAA,
    .version = 1,
    .data_type = 0x01,
    .thumb = (uint8_t)bendPercent[0],
    .index = (uint8_t)bendPercent[1],
    .middle = (uint8_t)bendPercent[2],
    .ring = (uint8_t)bendPercent[3],
    .pinky = (uint8_t)bendPercent[4],
    .wrist = (int16_t)(wrist_val * 1000),
    .seq_num = ++packet_seq_num,
    .crc = 0,
    .tail = 0x55
  };

  frame.crc = crc16Ccitt((uint8_t*)&frame, CRC_DATA_LENGTH);

  if (!enqueueSendData(&frame)) {
    Serial.println("[ESPNOW] 数据包入队失败");
  }

  // ========== USB Serial 调试输出 ==========
  Serial.printf("{\"thumb\":%.3f,\"index\":%.3f,\"middle\":%.3f,\"ring\":%.3f,\"pinky\":%.3f,\"wrist\":%.3f,\"seq\":%d}\n",
               bendPercent[0] / 100.0,
               bendPercent[1] / 100.0,
               bendPercent[2] / 100.0,
               bendPercent[3] / 100.0,
               bendPercent[4] / 100.0,
               wrist_val,
               packet_seq_num);
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
  uint8_t n = Wire.requestFrom((uint8_t)MPU_ADDR, len);
  if (n != len) return false;
  for (uint8_t i = 0; i < len; i++) {
    buf[i] = Wire.read();
  }
  return true;
}

bool mpuReadAll() {
  uint8_t buf[14];
  if (!mpuReadBytes(MPU_ACCEL_XOUT_H, buf, 14)) return false;
  ax_raw = (int16_t)((buf[0] << 8) | buf[1]);
  ay_raw = (int16_t)((buf[2] << 8) | buf[3]);
  az_raw = (int16_t)((buf[4] << 8) | buf[5]);
  gx_raw = (int16_t)((buf[8] << 8) | buf[9]);
  gy_raw = (int16_t)((buf[10] << 8) | buf[11]);
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
  // 使用 roll 轴（X轴旋转）：减去初始姿态偏移，取负校正方向
  float centered = -(angle_deg - roll_offset);
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
    delay(1000);
  }
}

void calibrateStraightAll() {
  unsigned long start = millis();

  while (millis() - start < 2000) {
    for (int i = 0; i < FLEX_COUNT; i++) {
      float v = analogRead(FLEX_PINS[i]) * VREF / ADC_MAX;
      if (v > voltageStraight[i]) voltageStraight[i] = v;
    }
    delay(10);
  }
}

void calibrateBentAll() {
  unsigned long start = millis();

  while (millis() - start < 2000) {
    for (int i = 0; i < FLEX_COUNT; i++) {
      float v = analogRead(FLEX_PINS[i]) * VREF / ADC_MAX;
      if (v < voltageBent[i]) voltageBent[i] = v;
    }
    delay(10);
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

void handleSerialCommand() {
  if (!Serial.available()) return;

  String cmd = Serial.readStringUntil('\n');
  cmd.trim();

  if (cmd.startsWith("FREQ:")) {
    int freq = cmd.substring(5).toInt();

    if (freq >= 1 && freq <= 100) {
      sampleFrequency = freq;
      sampleIntervalMs = 1000 / sampleFrequency;
    }
  }
}