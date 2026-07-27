"""
DeepSeek AI 客户端 - 手势解释与对话预测
"""
import os
import json
import requests
import logging

logger = logging.getLogger("DeepSeekClient")

DEEPSEEK_API_KEY = os.environ.get("DEEPSEEK_API_KEY", "sk-b0c9abb004374c309287aeb23092f9c0")
DEEPSEEK_BASE_URL = os.environ.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com")
DEEPSEEK_MODEL = os.environ.get("DEEPSEEK_MODEL", "deepseek-v4-flash")


def _call_deepseek(messages, temperature=0.7, max_tokens=1000):
    """调用 DeepSeek API"""
    if not DEEPSEEK_API_KEY:
        raise ValueError("DEEPSEEK_API_KEY 未配置")

    url = f"{DEEPSEEK_BASE_URL}/chat/completions"
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {DEEPSEEK_API_KEY}",
    }
    payload = {
        "model": DEEPSEEK_MODEL,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": False,
    }

    try:
        resp = requests.post(url, headers=headers, json=payload, timeout=30)
        resp.raise_for_status()
        data = resp.json()
        return data["choices"][0]["message"]["content"]
    except Exception as e:
        logger.error(f"DeepSeek API 调用失败: {e}")
        raise


def explain_gesture(gesture_name_cn: str, gesture_name_en: str = "") -> dict:
    """
    对指定手势进行详细解释

    返回:
        {
            "meaning": "标准含义",
            "culture": "文化背景差异",
            "variants": "变体形式",
            "usage": "使用场景"
        }
    """
    name = gesture_name_cn or gesture_name_en
    prompt = f"""请对手势「{name}」进行详细解释，返回严格的JSON格式，包含以下字段：

- meaning: 标准含义（这个手势通常表示什么）
- culture: 文化背景差异（在不同国家/文化中有什么不同含义，特别注意是否有冒犯性含义）
- variants: 变体形式（这个手势有哪些常见的变体或相似手势）
- usage: 使用场景（通常在什么场合使用这个手势）

请用中文回答，直接返回JSON，不要包含任何其他文字或markdown标记。"""

    messages = [
        {"role": "system", "content": "你是一位手语研究专家和文化人类学家，精通全球各种手势语和肢体语言的文化含义。"},
        {"role": "user", "content": prompt},
    ]

    try:
        result = _call_deepseek(messages, temperature=0.7, max_tokens=800)
        result = result.strip()
        if result.startswith("```json"):
            result = result[7:]
        if result.startswith("```"):
            result = result[3:]
        if result.endswith("```"):
            result = result[:-3]
        result = result.strip()
        return json.loads(result)
    except json.JSONDecodeError as e:
        logger.error(f"解析手势解释失败: {e}, 原始内容: {result}")
        return {
            "meaning": f"「{name}」是一个常用手势。",
            "culture": "不同文化中手势含义可能有差异，使用时需注意语境。",
            "variants": "该手势可能存在多种变体形式。",
            "usage": "常用于日常交流表达。"
        }
    except Exception as e:
        logger.error(f"手势解释失败: {e}")
        return {
            "meaning": f"「{name}」手势",
            "culture": "（AI服务暂不可用）",
            "variants": "（AI服务暂不可用）",
            "usage": "（AI服务暂不可用）"
        }


def predict_next_sentence(gesture_history: list, context: str = "") -> str:
    """
    基于手势序列预测下一个最可能的句子

    参数:
        gesture_history: 手势名称列表，按时间顺序排列
        context: 额外的上下文信息

    返回:
        预测的下一句话（中文）
    """
    if not gesture_history:
        return "请先输入一些手势"

    gesture_str = " → ".join(gesture_history)
    prompt = f"""以下是一段手语交流中已经出现的手势序列（按时间顺序）：

{gesture_str}

{'额外上下文: ' + context if context else ''}

请基于正常的中文交流逻辑，预测接下来最可能出现的一句话。要求：
1. 预测内容要与前文逻辑连贯、语义相关
2. 符合正常交流模式，自然流畅
3. 考虑手势序列可能表达的完整含义
4. 用中文回答，直接输出句子，不要包含解释或其他内容
5. 长度控制在1-2句话"""

    messages = [
        {"role": "system", "content": "你是一位手语翻译专家和自然语言处理专家，擅长根据手语手势序列推断完整的语义和对话内容。"},
        {"role": "user", "content": prompt},
    ]

    try:
        result = _call_deepseek(messages, temperature=0.8, max_tokens=300)
        return result.strip().strip('"').strip("'")
    except Exception as e:
        logger.error(f"下一句预测失败: {e}")
        return "（AI服务暂不可用，无法预测）"
