/*
 * Flex Sensor 5-Channel + MPU6050 Gesture Recognition
 * 输出给 serial.js 的格式（JSON）：
 * {"thumb":0.25,"index":0.50,"middle":0.80,"ring":0.30,"pinky":0.10,"wrist":0.15}
 * 手指值范围：0.000 ~ 1.000
 * 手腕值范围：-0.4 ~ 0.4
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

#define FLEX_COUNT 5

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

int sampleFrequency = 20;
unsigned long sampleIntervalMs = 50;
unsigned long lastSampleMs = 0;

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

// ====================================================
// 初始化
// ====================================================
void setup() {
  Serial.begin(115200);
  Serial.setTimeout(20);

  analogReadResolution(12);
  analogSetAttenuation(ADC_11db);

  Serial.println("==== 系统启动 ====");

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
    angles_initialized = true;
  }

  last_mpu_us = micros();
  Serial.println("MPU6050 校准完成！");

  // ========== Flex Sensor 初始化 ==========
  Serial.println("准备进行手指校准...");

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
  Serial.println("==== 校准完成！进入实时识别模式 ====");
  Serial.println("JSON格式: {\"thumb\":0.000,\"index\":0.000,\"middle\":0.000,\"ring\":0.000,\"pinky\":0.000,\"wrist\":0.00}");
  Serial.println("指令格式: FREQ:<1-100>");
  calibrated = true;
}

// ====================================================
// 主循环：实时输出 JSON
// ====================================================
void loop() {
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
  if (!calibrated) return;

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

  // ========== 输出 JSON 格式 ==========
  float wrist_val = mapWristAngle(pitch_deg);

  Serial.printf("{\"thumb\":%.3f,\"index\":%.3f,\"middle\":%.3f,\"ring\":%.3f,\"pinky\":%.3f,\"wrist\":%.3f}\n",
               bendPercent[0] / 100.0,
               bendPercent[1] / 100.0,
               bendPercent[2] / 100.0,
               bendPercent[3] / 100.0,
               bendPercent[4] / 100.0,
               wrist_val);
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
  uint8_t n = Wire.requestFrom(MPU_ADDR, len);
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
  float rad = angle_deg * PI / 180.0f;
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
