#include <Wire.h>
#include <math.h>

#define I2C_SDA        8
#define I2C_SCL        9
#define I2C_FREQ       400000
#define MPU_ADDR       0x68

const float target_hz = 200.0f;
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
uint32_t last_us = 0;

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

void calibrateGyro(uint16_t samples = 500) {
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

void setup() {
  Serial.begin(115200);
  delay(200);

  Wire.begin(I2C_SDA, I2C_SCL, I2C_FREQ);
  delay(50);

  if (!mpuInit()) {
    Serial.println("MPU6050 init failed.");
    while (1) { delay(500); }
  }
  Serial.println("MPU6050 init OK.");

  Serial.println("Calibrating gyro...");
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

  last_us = micros();
  Serial.println("Ready.");
}

void loop() {
  uint32_t now_us = micros();
  float dt = (now_us - last_us) / 1e6f;
  if (dt <= 0) dt = 1.0f / target_hz;
  last_us = now_us;

  if (!mpuReadAll()) return;

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

  static uint32_t lastPrint = 0;
  uint32_t now_ms = millis();
  if (now_ms - lastPrint > 100) {
    lastPrint = now_ms;
    Serial.printf("{\"p\":%.2f,\"r\":%.2f,\"y\":%.2f,\"gx\":%.2f,\"gy\":%.2f,\"gz\":%.2f,\"ax\":%.3f,\"ay\":%.3f,\"az\":%.3f}\n",
                  pitch_deg, roll_deg, yaw_deg, gx_dps, gy_dps, gz_dps, ax_g, ay_g, az_g);
  }

  float loop_target_us = 1e6f / target_hz;
  uint32_t used = micros() - now_us;
  if (used < loop_target_us) {
    delayMicroseconds((uint32_t)(loop_target_us - used));
  }
}