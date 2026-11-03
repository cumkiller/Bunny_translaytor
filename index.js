```javascript
(function () {
    "use strict";

    const v = typeof vendetta !== "undefined" ? vendetta : window.vendetta;
    const translatedCache = new Map();
    const pendingIds = new Set();
    let patches = [];

    const PHRASE_SLANG = [
        [/\bno cap\b/gi, "без шуток"],
        [/\bfor real\b/gi, "серьёзно"],
        [/\bnot gonna lie\b/gi, "честно говоря"],
        [/\bto be honest\b/gi, "честно говоря"],
        [/\bin my opinion\b/gi, "по-моему"],
        [/\btouch grass\b/gi, "проветрись на улице"],
        [/\brent free\b/gi, "не выходит из головы"],
        [/\bcrash out\b/gi, "сорваться и психануть"],
        [/\blocked in\b/gi, "максимально сосредоточен"],
        [/\blet him cook\b/gi, "не мешай ему"],
        [/\bwe are cooked\b/gi, "нам конец"],
        [/\bwe'?re cooked\b/gi, "нам конец"],
        [/\bi'?m cooked\b/gi, "мне конец"],
        [/\bskill issue\b/gi, "проблема со скиллом"],
        [/\bon god\b/gi, "клянусь"],
        [/\bmy bad\b/gi, "мой косяк"],
        [/\bhit me up\b/gi, "напиши мне"]
    ];

    const WORD_SLANG = {
        "ngl": "честно говоря", "fr": "реально", "frfr": "вот реально",
        "ong": "клянусь", "tbh": "честно говоря", "imo": "по-моему",
        "idk": "не знаю", "idc": "мне всё равно", "wdym": "в каком смысле",
        "istg": "клянусь богом", "icl": "не буду врать", "iykyk": "кто понял тот понял",
        "rn": "прямо сейчас", "irl": "в реале", "deadass": "на полном серьёзе",
        "cap": "враньё", "based": "база", "cringe": "кринж", "sus": "подозрительно",
        "goat": "легенда", "rizz": "харизма", "cooked": "спекся",
        "glaze": "подлизываться", "delulu": "в иллюзиях", "yapping": "болтовня",
        "opps": "враги", "bruh": "братан", "bro": "бро", "btw": "кстати",
        "omw": "уже иду", "brb": "скоро буду", "afk": "отошёл",
        "gtg": "мне пора", "lmk": "дай знать", "hmu": "напиши мне",
        "ty": "спасибо", "tysm": "огромное спасибо", "gg": "хорошая игра"
    };

    function shouldTranslate(text) {
        if (!text || typeof text !== "string") return false;
        const clean = text
            .replace(/<a?:[a-zA-Z0-9_]+:\d+>/g, "")
            .replace(/<[@#&!]\d+>/g, "")
            .replace(/https?:\/\/\S+/g, "")
            .trim();
        if (clean.length < 2) return false;
        const latinCount = (clean.match(/[a-zA-Z]/g) || []).length;
        const cyrillicCount = (clean.match(/[а-яА-ЯёЁ]/g) || []).length;
        return latinCount > 0 && cyrillicCount <= latinCount * 2;
    }

    function preprocessSlang(text) {
        let result = text;
        for (const [regex, replacement] of PHRASE_SLANG) {
            result = result.replace(regex, replacement);
        }
        return result.replace(/\b([a-zA-Z0-9']+)\b/g, (word) => {
            const lower = word.toLowerCase();
            return WORD_SLANG[lower] || word;
        });
    }

    async function translateText(rawText) {
        const tokens = [];
        const tokenRegex = /(```[\s\S]*?```|`[^`\n]+`|<a?:[a-zA-Z0-9_]+:\d+>|<[@#&!]\d+>|https?:\/\/\S+)/g;
        const protectedText = rawText.replace(tokenRegex, (match) => {
            const idx = tokens.length;
            tokens.push(match);
            return `[#${idx}#]`;
        });

        const prepared = preprocessSlang(protectedText);
        const url = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=ru&dt=t&q=" + encodeURIComponent(prepared);
        const response = await fetch(url);
        const data = await response.json();
        let translated = data[0].map((part) => part[0]).join("");

        tokens.forEach((token, idx) => {
            translated = translated.replace(new RegExp(`\\[#\\s*${idx}\\s*#\\]`, "g"), token);
        });
        return translated;
    }

    return {
        onLoad() {
            try {
                const FluxDispatcher = v?.metro?.common?.FluxDispatcher || v?.metro?.findByProps?.("dispatch", "subscribe");
                const MessageStore = v?.metro?.findByStoreName?.("MessageStore");
                const UserStore = v?.metro?.findByStoreName?.("UserStore");

                if (!FluxDispatcher) return;

                async function processMessage(msg) {
                    try {
                        if (!msg?.id || !msg?.channel_id || !msg?.content) return;
                        if (pendingIds.has(msg.id) || msg.content.includes("\n-# 🇬🇧 ")) return;

                        const currentUserId = UserStore?.getCurrentUser?.()?.id;
                        if (currentUserId && msg.author?.id === currentUserId) return;
                        if (!shouldTranslate(msg.content)) return;

                        pendingIds.add(msg.id);
                        const original = msg.content;
                        const translated = await translateText(original);

                        if (translated && translated.trim().toLowerCase() !== original.trim().toLowerCase()) {
                            const currentMsg = MessageStore?.getMessage?.(msg.channel_id, msg.id) || msg;
                            FluxDispatcher.dispatch({
                                type: "MESSAGE_UPDATE",
                                message: {
                                    ...currentMsg,
                                    id: msg.id,
                                    channel_id: msg.channel_id,
                                    content: `${translated}\n-# 🇬🇧 ${original}`
                                }
                            });
                        }
                    } catch (e) {
                    } finally {
                        if (msg?.id) pendingIds.delete(msg.id);
                    }
                }

                const onMessageCreate = (event) => {
                    if (event?.message) setTimeout(() => processMessage(event.message), 150);
                };

                const onLoadMessages = (event) => {
                    if (Array.isArray(event?.messages)) {
                        event.messages.slice(0, 15).forEach((m, i) => {
                            setTimeout(() => processMessage(m), 200 * (i + 1));
                        });
                    }
                };

                FluxDispatcher.subscribe("MESSAGE_CREATE", onMessageCreate);
                FluxDispatcher.subscribe("LOAD_MESSAGES_SUCCESS", onLoadMessages);

                patches.push(() => {
                    FluxDispatcher.unsubscribe("MESSAGE_CREATE", onMessageCreate);
                    FluxDispatcher.unsubscribe("LOAD_MESSAGES_SUCCESS", onLoadMessages);
                });
            } catch (e) {}
        },
        onUnload() {
            patches.forEach((fn) => {
                try { fn(); } catch (e) {}
            });
            patches = [];
            translatedCache.clear();
            pendingIds.clear();
        }
    };
})();
```
