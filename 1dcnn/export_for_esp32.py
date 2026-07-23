"""
PyTorch → TensorFlow Lite → ESP32 模型转换

将训练好的 1D-CNN 手势识别模型转换为 TFLite 格式，
并提供 ESP32 端 C++ 推理代码。

============================================================
转换流程:
  python export_for_esp32.py checkpoint.pth --out gesture_model

输出:
  gesture_model.tflite     ← ESP32 端使用的模型文件
  gesture_model.h           ← 直接可 #include 的 C 头文件 (可选)
  esp32_inference.cpp       ← ESP32 端推理示例代码
============================================================

依赖:
  pip install onnx onnx2tf tensorflow  (推荐)
  或:  pip install ai-edge-torch  (PyTorch → TFLite 直转)

用法:
  python export_for_esp32.py checkpoint.pth
  python export_for_esp32.py checkpoint.pth --num-classes 5 --quantize
"""
import argparse
import struct
import sys
from pathlib import Path
from typing import Optional

from labels import GESTURE_NAMES_EN


# ============================================================
#  方法1: PyTorch → ONNX → TFLite (最稳定)
# ============================================================

def export_via_onnx(
    model_path: str,
    output_path: str,
    num_classes: int = 5,
    quantize: bool = False,
):
    """PyTorch → ONNX → TensorFlow → TFLite"""
    import torch
    import onnx
    from cnn import HandGestureCNN1D

    output_path = Path(output_path)
    onnx_path = output_path.with_suffix(".onnx")
    tflite_path = output_path.with_suffix(".tflite")

    # ---- 1. 加载 PyTorch 模型 ----
    print("[1/4] 加载 PyTorch 模型...")
    model = HandGestureCNN1D(num_classes=num_classes)
    state = torch.load(model_path, map_location="cpu", weights_only=True)
    model.load_state_dict(state)
    model.eval()

    # ---- 2. PyTorch → ONNX ----
    print("[2/4] PyTorch → ONNX ...")
    dummy = torch.randn(1, 1, 12)
    torch.onnx.export(
        model, dummy, str(onnx_path),
        input_names=["input"],
        output_names=["output"],
        dynamic_axes={"input": {0: "batch"}, "output": {0: "batch"}},
        opset_version=12,
    )
    print(f"    ✓ {onnx_path}")

    # ---- 3. ONNX → TensorFlow SavedModel ----
    print("[3/4] ONNX → TensorFlow ...")
    try:
        import onnx2tf
        import tensorflow as tf

        tf_path = output_path.with_suffix("")
        onnx2tf.convert(
            input_onnx_file_path=str(onnx_path),
            output_folder_path=str(tf_path),
            output_signaturedefs=True,
        )
        print(f"    ✓ {tf_path}")
        model_dir = tf_path
    except ImportError:
        print("    ⚠ onnx2tf 未安装，尝试 onnx-tf ...")
        from onnx_tf.backend import prepare
        onnx_model = onnx.load(str(onnx_path))
        tf_rep = prepare(onnx_model)

        tf_path = output_path.with_suffix("_tf")
        tf_path.mkdir(parents=True, exist_ok=True)
        tf_rep.export_graph(str(tf_path))
        print(f"    ✓ {tf_path}")
        model_dir = tf_path

    # ---- 4. TFLite 转换 ----
    print("[4/4] TensorFlow → TFLite ...")
    import tensorflow as tf

    converter = tf.lite.TFLiteConverter.from_saved_model(str(model_dir))

    if quantize:
        # INT8 量化 — 模型缩小 4x，速度更快
        converter.optimizations = [tf.lite.Optimize.DEFAULT]

        def representative_dataset():
            for _ in range(100):
                yield [torch.randn(1, 1, 12).numpy().astype("float32")]
        converter.representative_dataset = representative_dataset
        converter.target_spec.supported_ops = [
            tf.lite.OpsSet.TFLITE_BUILTINS_INT8
        ]
        converter.inference_input_type = tf.float32
        converter.inference_output_type = tf.float32
        print("    (INT8 量化)")

    tflite_model = converter.convert()

    with open(tflite_path, "wb") as f:
        f.write(tflite_model)

    size_kb = len(tflite_model) / 1024
    print(f"    ✓ {tflite_path}  ({size_kb:.1f} KB)")

    # 验证
    _verify_tflite(str(tflite_path))

    return tflite_path


# ============================================================
#  方法2: PyTorch → TFLite 直转 (ai-edge-torch, 更简单)
# ============================================================

def export_via_ai_edge(
    model_path: str,
    output_path: str,
    num_classes: int = 5,
    quantize: bool = False,
):
    """
    PyTorch → TFLite 直转 (需要 ai-edge-torch)
    pip install ai-edge-torch
    """
    import torch
    import ai_edge_torch
    from cnn import HandGestureCNN1D

    output_path = Path(output_path)
    tflite_path = output_path.with_suffix(".tflite")

    print("[1/2] 加载 PyTorch 模型...")
    model = HandGestureCNN1D(num_classes=num_classes)
    state = torch.load(model_path, map_location="cpu", weights_only=True)
    model.load_state_dict(state)
    model.eval()

    print("[2/2] PyTorch → TFLite ...")
    sample = (torch.randn(1, 1, 12),)
    edge_model = ai_edge_torch.convert(model, sample)

    if quantize:
        edge_model = ai_edge_torch.quantize(edge_model)
        print("    (quantized)")

    edge_model.export(str(tflite_path))

    size_kb = Path(tflite_path).stat().st_size / 1024
    print(f"    ✓ {tflite_path}  ({size_kb:.1f} KB)")

    _verify_tflite(str(tflite_path))
    return tflite_path


# ============================================================
#  TFLite 验证
# ============================================================

def _verify_tflite(tflite_path: str):
    """加载 TFLite 并跑一次推理验证"""
    try:
        import numpy as np
        import tensorflow as tf

        interpreter = tf.lite.Interpreter(model_path=tflite_path)
        interpreter.allocate_tensors()

        input_details = interpreter.get_input_details()
        output_details = interpreter.get_output_details()

        print(f"\n    📐 输入: {input_details[0]['shape']} ({input_details[0]['dtype']})")
        print(f"    📐 输出: {output_details[0]['shape']} ({output_details[0]['dtype']})")

        # 测试推理
        dummy = np.random.randn(1, 1, 12).astype(np.float32)
        interpreter.set_tensor(input_details[0]["index"], dummy)
        interpreter.invoke()
        result = interpreter.get_tensor(output_details[0]["index"])
        print(f"    ✅ 验证通过: 输入 (1,1,12) → 输出 {result.shape}")
    except ImportError:
        print("\n    (跳过验证 — 未安装 tensorflow)")


# ============================================================
#  生成 ESP32 Arduino 推理代码
# ============================================================

def _build_esp32_code(num_classes: int) -> str:
    """根据 labels.py 中的 GESTURE_NAMES_EN 生成 ESP32 C++ 推理代码"""
    names_en = [GESTURE_NAMES_EN.get(i, f"gesture_{i}") for i in range(num_classes)]
    names_str = ", ".join(f'"{n}"' for n in names_en)

    return f"""\
/**
 * ESP32-S3 手势识别推理代码
 * (自动生成 — 标签来自 labels.py)
 *
 * 使用: 将 gesture_model.tflite 上传到 SPIFFS 或 LittleFS
 * 依赖: EloquentTinyML 库 (Arduino Library Manager 安装)
 *
 * Arduino IDE:
 *   工具 → 管理库 → 搜索 "EloquentTinyML" 安装
 *
 * 连线 (IMU 示例, MPU6050):
 *   SDA → GPIO21, SCL → GPIO22
 */
#include <EloquentTinyML.h>
#include "gesture_model.h"   // 模型文件转为 .h

// 模型定义 (在 gesture_model.h 中用 xxd 或 bin2c 生成)
// const unsigned char gesture_model_tflite[] = {{ ... }};
// const unsigned int gesture_model_tflite_len = XXXX;

#define NUM_FEATURES   12
#define NUM_CLASSES     {num_classes}
#define TENSOR_ARENA_SIZE  (8 * 1024)  // 8 KB 足够

Eloquent::TinyML::TfLite<NUM_FEATURES, NUM_CLASSES, TENSOR_ARENA_SIZE> ml;

// 手势名称 (来自 labels.py)
const char* gesture_names[] = {{
    {names_str}
}};

void setup() {{
    Serial.begin(115200);
    while (!Serial);

    // 初始化 TFLite
    ml.begin(gesture_model_tflite);
    Serial.println("✅ Model loaded");
    delay(1000);
}}

void loop() {{
    // 获取传感器数据 → 12 个特征
    float features[NUM_FEATURES];

    // === 示例: 填充模拟数据, 实际应替换为传感器读取 ===
    // 左手: thumb, index, middle, ring, pinky, wrist
    // 右手: thumb, index, middle, ring, pinky, wrist
    read_sensor_data(features);

    // === 推理 ===
    int predicted = ml.predictClass(features);
    float probs[NUM_CLASSES];
    ml.predict(features, probs);

    // === 输出结果 ===
    Serial.print("Gesture: ");
    Serial.print(gesture_names[predicted]);
    Serial.print("  (");
    Serial.print(probs[predicted] * 100, 1);
    Serial.println("%)");

    delay(100);  // 100 Hz
}}

/**
 * 从传感器读取 12 个手指弯曲值
 * 替换为你的实际传感器读取逻辑
 */
void read_sensor_data(float *features) {{
    // TODO: 实现你的传感器读取
    // features[0]  = 左手拇指
    // features[1]  = 左手食指
    // features[2]  = 左手中指
    // features[3]  = 左手无名指
    // features[4]  = 左手小指
    // features[5]  = 左手手腕
    // features[6]  = 右手拇指
    // features[7]  = 右手食指
    // features[8]  = 右手中指
    // features[9]  = 右手无名指
    // features[10] = 右手小指
    // features[11] = 右手手腕
}}
"""


def generate_esp32_code(output_dir: Path, num_classes: int = 5):
    """生成 ESP32 端推理示例 (标签名来自 labels.py)"""
    cpp_path = output_dir / "esp32_inference.ino"
    code = _build_esp32_code(num_classes)
    with open(cpp_path, "w", encoding="utf-8") as f:
        f.write(code)
    print(f"\n📄 ESP32 推理代码已生成: {cpp_path}")


def model_to_c_header(tflite_path: str, output_dir: Path):
    """将 TFLite 模型转为 C 头文件 (用于嵌入固件)"""
    tflite_path = Path(tflite_path)
    data = tflite_path.read_bytes()
    name = tflite_path.stem

    h_path = output_dir / f"{name}.h"

    lines = [
        f"// Auto-generated from {tflite_path.name}",
        f"// Size: {len(data)} bytes",
        f"#ifndef {name.upper()}_H_",
        f"#define {name.upper()}_H_",
        f"",
        f"const unsigned char {name}_tflite[] = {{",
    ]

    for i in range(0, len(data), 12):
        chunk = data[i:i+12]
        lines.append("    " + ", ".join(f"0x{b:02x}" for b in chunk) + ",")

    lines += [
        "};",
        f"const unsigned int {name}_tflite_len = {len(data)};",
        f"",
        f"#endif  // {name.upper()}_H_",
    ]

    with open(h_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))

    print(f"📄 C 头文件已生成: {h_path}  ({len(data)} bytes)")


# ============================================================
#  转换指标对比
# ============================================================

def compare_models(pth_path: str, tflite_path: str):
    """对比原模型和 TFLite 模型的输出"""
    try:
        import torch
        import numpy as np
        import tensorflow as tf
        from cnn import HandGestureCNN1D

        # PyTorch 推理
        model = HandGestureCNN1D(num_classes=5)
        state = torch.load(pth_path, map_location="cpu", weights_only=True)
        model.load_state_dict(state)
        model.eval()

        dummy = torch.randn(1, 1, 12)
        with torch.no_grad():
            pt_out = model(dummy).numpy()

        # TFLite 推理
        interpreter = tf.lite.Interpreter(model_path=tflite_path)
        interpreter.allocate_tensors()
        io = interpreter.get_input_details()[0]
        oo = interpreter.get_output_details()[0]
        interpreter.set_tensor(io["index"], dummy.numpy().astype(np.float32))
        interpreter.invoke()
        tf_out = interpreter.get_tensor(oo["index"])

        diff = np.abs(pt_out - tf_out).max()
        print(f"\n📊 输出差异 (max |pt - tflite|): {diff:.6f}")
        if diff < 0.01:
            print("   ✅ 精度无损")
        elif diff < 0.1:
            print("   ⚠ 略有损失 (<0.1)")
        else:
            print("   ❌ 差异较大，请检查转换流程")

        print(f"\n   PyTorch 输出: {pt_out[0]}")
        print(f"   TFLite  输出: {tf_out[0]}")

    except ImportError:
        pass


# ============================================================
#  Main
# ============================================================

def main():
    parser = argparse.ArgumentParser(
        description="PyTorch → TFLite 模型转换 & ESP32 部署",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
转换方式:
  方式A (推荐):  python export_for_esp32.py model.pth
                 # PyTorch → ONNX → TensorFlow → TFLite
                 # 依赖: pip install onnx onnx2tf tensorflow

  方式B:         python export_for_esp32.py model.pth --method ai_edge
                 # PyTorch → TFLite 直转
                 # 依赖: pip install ai-edge-torch

示例:
  python export_for_esp32.py checkpoint.pth
  python export_for_esp32.py checkpoint.pth --quantize --num-classes 5
  python export_for_esp32.py checkpoint.pth --generate-h
        """,
    )
    parser.add_argument("model", help="PyTorch 模型路径 (.pth)")
    parser.add_argument("--out", default="gesture_model",
                        help="输出前缀 (默认 gesture_model)")
    parser.add_argument("--num-classes", type=int, default=5,
                        help="分类类别数")
    parser.add_argument("--quantize", action="store_true",
                        help="INT8 量化 (模型缩小 4x)")
    parser.add_argument("--method", choices=["onnx", "ai_edge"],
                        default="onnx", help="转换方式")
    parser.add_argument("--generate-h", action="store_true",
                        help="同时生成 C 头文件")
    args = parser.parse_args()

    out_dir = Path(args.out).parent or Path(".")
    out_dir.mkdir(parents=True, exist_ok=True)
    output_prefix = args.out

    # ---- 转换 ----
    print("=" * 50)
    print("  PyTorch → TFLite 模型转换")
    print("=" * 50)

    if args.method == "ai_edge":
        tflite_path = export_via_ai_edge(
            args.model, output_prefix, args.num_classes, args.quantize
        )
    else:
        tflite_path = export_via_onnx(
            args.model, output_prefix, args.num_classes, args.quantize
        )

    # ---- 对比 ----
    compare_models(args.model, str(tflite_path))

    # ---- 生成 C 头文件 ----
    if args.generate_h:
        model_to_c_header(str(tflite_path), out_dir)

    # ---- 生成 ESP32 推理代码 ----
    generate_esp32_code(out_dir, args.num_classes)

    # ---- 总结 ----
    print("\n" + "=" * 50)
    print("✅ 完成！部署到 ESP32 的步骤:")
    print("=" * 50)
    print()
    print("1. Arduino IDE 安装 EloquentTinyML 库:")
    print("   工具 → 管理库 → 搜索安装 EloquentTinyML")
    print()
    print("2. 将模型文件上传到 ESP32:")
    print("   方法A: 使用 LittleFS 上传工具上传 .tflite 文件")
    print("   方法B: 将 .h 头文件放入 sketch 目录直接编译")
    print(f"       python export_for_esp32.py {args.model} --generate-h")
    print()
    print("3. 将 esp32_inference.ino 中的 read_sensor_data()")
    print("   替换为你的实际传感器读取代码")
    print()
    print("4. 编译上传到 ESP32-S3")
    print(f"   模型大小: {Path(tflite_path).stat().st_size / 1024:.1f} KB")
    print("=" * 50)


if __name__ == "__main__":
    main()
