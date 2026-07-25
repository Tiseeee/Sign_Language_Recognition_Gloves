// ============================================================
// labels.js - 标签映射表（英文 → 中文）
// 用法：在 LABEL_MAP 中添加一行即可扩展新词汇
//       key 为模型返回的英文标签（统一小写），value 为中文显示文本
// ============================================================

export const LABEL_MAP = {
    // ── 数字 ──
    "zero":  "零",
    "one":   "一",
    "two":   "二",
    "three": "三",
    "four":  "四",
    "five":  "五",
    "six":   "六",
    "seven": "七",
    "eight": "八",
    "nine":  "九",
    "ten":   "十",

    // ── 1D-CNN 手势识别标签 ──
    "zero":  "零",
    "one":   "一",
    "two":   "二",
    "three": "三",
    "four":  "四",
    "five":  "五",

    // ── 后续可继续添加更多词汇 ──
    // "hello":    "你好",
    // "thanks":   "谢谢",
    // "goodbye":  "再见",
    // "yes":      "是",
    // "no":       "不是",
    // "please":   "请",
    // "sorry":    "对不起",
    // "help":     "帮助",
    // "love":     "爱",
    // "family":   "家",
};

/**
 * 将模型返回的英文标签转为中文显示文本
 * @param {string} englishLabel - 模型输出的原始标签
 * @returns {string} 中文显示文本；若未匹配则返回原标签
 */
export function translateLabel(englishLabel) {
    if (!englishLabel) return englishLabel;
    return LABEL_MAP[englishLabel.toLowerCase()] || englishLabel;
}
