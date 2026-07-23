// ============================================================
// voice.js - 语音播报模块（重写版）
// 新按钮默认关闭，语音逻辑直接绑在按钮状态上
// ============================================================

(function () {
    'use strict';

    // 隐藏旧按钮（如果存在）
    var oldBtn = document.getElementById('voice-toggle');
    if (oldBtn) oldBtn.style.display = 'none';

    // ── 核心状态 ──
    var _enabled = false;   // 默认关闭
    var _lastLabel = '';
    var _speaking = false;

    // ── 创建新按钮 ──
    function createButton() {
        if (document.getElementById('voice-btn')) return;
        if (!document.body) { setTimeout(createButton, 50); return; }

        var btn = document.createElement('button');
        btn.id = 'voice-btn';
        btn.innerHTML = '🔇';
        btn.style.cssText =
            'position:fixed;bottom:24px;right:24px;width:48px;height:48px;' +
            'border:none;border-radius:50%;font-size:22px;cursor:pointer;z-index:1002;' +
            'background:rgba(80,80,80,0.65);backdrop-filter:blur(8px);' +
            'box-shadow:0 4px 15px rgba(0,0,0,0.4);' +
            'transition:background 0.25s,transform 0.15s;' +
            'display:flex;align-items:center;justify-content:center;line-height:1;';
        btn.title = '语音播报：关';

        btn.addEventListener('mouseenter', function () {
            btn.style.background = _enabled
                ? 'rgba(107,106,179,0.75)' : 'rgba(120,120,120,0.75)';
            btn.style.transform = 'scale(1.1)';
        });
        btn.addEventListener('mouseleave', function () {
            btn.style.background = _enabled
                ? 'rgba(0,0,0,0.65)' : 'rgba(80,80,80,0.65)';
            btn.style.transform = 'scale(1)';
        });

        btn.addEventListener('click', function () {
            _enabled = !_enabled;
            if (_enabled) {
                // ── 打开语音 ──
                btn.innerHTML = '🔊';
                btn.title = '语音播报：开';
                btn.style.background = 'rgba(0,0,0,0.65)';
            } else {
                // ── 关闭语音：取消当前播放、清空记录 ──
                btn.innerHTML = '🔇';
                btn.title = '语音播报：关';
                btn.style.background = 'rgba(80,80,80,0.65)';
                speechSynthesis.cancel();
                _lastLabel = '';
                _speaking = false;
            }
        });

        document.body.appendChild(btn);
    }

    // ── 播报函数 ──
    window.speakVoice = function (text, confidence) {
        // 关闭状态 → 不播报
        if (!_enabled || !text) return;
        // 和上次一样的内容 → 不重复
        if (text === _lastLabel) return;
        // 正在播报中 → 不等它播完绝不插队
        if (_speaking) return;

        _lastLabel = text;
        _speaking = true;

        var u = new SpeechSynthesisUtterance(text);
        u.lang = 'zh-CN';
        u.rate = 0.9;
        u.pitch = 1.0;
        u.volume = 1.0;
        u.onstart = function () {
            console.log('🔊 播报: "' + text + '"');
        };
        u.onend = function () {
            _speaking = false;
        };
        u.onerror = function (e) {
            _speaking = false;
            console.warn('语音播报失败:', e.error);
        };
        speechSynthesis.speak(u);
    };

    // ── 对外接口 ──
    window.isVoiceEnabled = function () { return _enabled; };
    window.setVoiceEnabled = function (v) {
        _enabled = v;
        var btn = document.getElementById('voice-btn');
        if (btn) {
            btn.innerHTML = v ? '🔊' : '🔇';
            btn.title = v ? '语音播报：开' : '语音播报：关';
            btn.style.background = v ? 'rgba(0,0,0,0.65)' : 'rgba(80,80,80,0.65)';
        }
        if (!v) {
            speechSynthesis.cancel();
            _lastLabel = '';
            _speaking = false;
        }
    };

    createButton();
    console.log('🎤 语音模块已就绪（新按钮，默认关闭）');
})();
