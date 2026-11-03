(function () {
    "use strict";

    const { metro, patcher, plugin, ui, commands, logger } = window.vendetta;
    const { findByProps, findByStoreName } = metro;
    const { FluxDispatcher, React, ReactNative } = metro.common;
    const { before, after } = patcher;
    const { storage } = plugin;
    const { showToast } = ui.toasts;
    const { Forms } = ui.components;
    const { FormSwitchRow, FormInput, FormSection, FormDivider } = Forms;

    storage.autoTranslate ??= true;
    storage.useSlangDict ??= true;
    storage.showOriginal ??= true;
    storage.ignoreOwnMessages ??= true;
    storage.useGemini ??= false;
    storage.geminiApiKey ??= "";

    const MessageStore = findByStoreName("MessageStore");
    const UserStore = findByStoreName("UserStore");
    const ActionSheet = findByProps("openLazy", "hideActionSheet");

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
        [/\bskill issue\b/gi, "руки не из того места"],
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
        const clean = text.replace(/<a?:[a-zA-Z0-9_]+:\d+>/g, "").replace(/<[@#&!]\d+>/g, "").replace(/https?:\/\/\S+/g, "").trim();
        if (clean.length < 2) return false;
        const latinCount = (clean.match(/[a-zA-Z]/g) || []).length;
        const cyrillicCount = (clean.match(/[а-яА-ЯёЁ]/g) || []).length;
        return latinCount > 0 && cyrillicCount <= latinCount * 2;
    }

    function protectDiscordTokens(text) {
        const tokens = [];
        const tokenRegex = /(```[\s\S]*?```|`[^`\n]+`|<a?:[a-zA-Z0-9_]+:\d+>|<[@#&!]\d+>|https?:\/\/\S+)/g;
        const protectedText = text.replace(tokenRegex, (match) => {
            const idx = tokens.length;
            tokens.push(match);
            return `[#${idx}#]`;
        });
        return { protectedText, tokens };
    }

    function restoreDiscordTokens(text, tokens) {
        let restored = text;
        tokens.forEach((token, idx) => {
            restored = restored.replace(new RegExp(`\\[#\\s*${idx}\\s*#\\]`, "g"), token);
        });
        return restored;
    }

    function preprocessSlang(text) {
        if (!storage.useSlangDict) return text;
        let result = text;
        for (const [regex, replacement] of PHRASE_SLANG) {
            result = result.replace(regex, replacement);
        }
        return result.replace(/\b([a-zA-Z0-9']+)\b/g, (word) => {
            const lower = word.toLowerCase();
            return WORD_SLANG[lower] || word;
        });
    }

    async function translateWithGoogle(text) {
        const prepared = preprocessSlang(text);
        const url = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=ru&dt=t&q=" + encodeURIComponent(prepared);
        const response = await fetch(url);
        if (!response.ok) throw new Error("Translation failed");
        const data = await response.json();
        return data[0].map((part) => part[0]).join("");
    }

    async function translateText(rawText) {
        const { protectedText, tokens } = protectDiscordTokens(rawText);
        const translated = await translateWithGoogle(protectedText);
        return restoreDiscordTokens(translated, tokens);
    }

    function applyTranslationToMessage(channelId, messageId, originalContent, translatedContent) {
        const currentMsg = MessageStore?.getMessage?.(channelId, messageId);
        if (!currentMsg) return;
        const formatted = storage.showOriginal ? `${translatedContent}\n-# 🇬🇧 ${originalContent}` : translatedContent;
        FluxDispatcher.dispatch({
            type: "MESSAGE_UPDATE",
            message: { ...currentMsg, id: messageId, channel_id: channelId, content: formatted }
        });
    }

    async function processMessage(msg, force = false) {
        if (!msg?.id || !msg?.channel_id || !msg?.content) return;
        if (pendingIds.has(msg.id) || msg.content.includes("\n-# 🇬🇧 ")) return;
        const currentUserId = UserStore?.getCurrentUser?.()?.id;
        if (!force && storage.ignoreOwnMessages && msg.author?.id === currentUserId) return;
        if (!force && !shouldTranslate(msg.content)) return;

        if (translatedCache.has(msg.id)) {
            const cached = translatedCache.get(msg.id);
            applyTranslationToMessage(msg.channel_id, msg.id, cached.original, cached.translated);
            return;
        }

        pendingIds.add(msg.id);
        try {
            const original = msg.content;
            const translated = await translateText(original);
            if (translated && translated.trim().toLowerCase() !== original.trim().toLowerCase()) {
                translatedCache.set(msg.id, { original, translated });
                applyTranslationToMessage(msg.channel_id, msg.id, original, translated);
            }
        } catch (err) {
            logger.error("Translate error:", err);
        } finally {
            pendingIds.delete(msg.id);
        }
    }

    function setupDispatcherHooks() {
        const onMessageCreate = (event) => {
            if (!storage.autoTranslate) return;
            const msg = event?.message;
            if (msg) setTimeout(() => processMessage(msg, false), 150);
        };
        const onLoadMessages = (event) => {
            if (!storage.autoTranslate) return;
            event?.messages?.slice(0, 15).forEach((msg, idx) => {
                setTimeout(() => processMessage(msg, false), 200 * (idx + 1));
            });
        };
        FluxDispatcher.subscribe("MESSAGE_CREATE", onMessageCreate);
        FluxDispatcher.subscribe("LOAD_MESSAGES_SUCCESS", onLoadMessages);
        patches.push(() => {
            FluxDispatcher.unsubscribe("MESSAGE_CREATE", onMessageCreate);
            FluxDispatcher.unsubscribe("LOAD_MESSAGES_SUCCESS", onLoadMessages);
        });
    }

    function setupSlashCommand() {
        if (!commands?.registerCommand) return;
        const unregister = commands.registerCommand({
            name: "tr",
            displayName: "tr",
            description: "Перевести текст со сленгом на русский",
            displayDescription: "Перевести текст со сленгом на русский",
            options: [{ name: "text", displayName: "text", description: "Текст", displayDescription: "Текст", required: true, type: 3 }],
            applicationId: "-1",
            inputType: 1,
            type: 1,
            execute: async (args) => {
                const input = args?.[0]?.value || "";
                try {
                    const result = await translateText(input);
                    return { content: `🌐 **Перевод:** ${result}\n-# Оригинал: ${input}` };
                } catch {
                    showToast("Ошибка перевода");
                }
            }
        });
        patches.push(unregister);
    }

    return {
        onLoad() {
            setupDispatcherHooks();
            setupSlashCommand();
            logger.log("RU Slang Translator loaded");
        },
        onUnload() {
            patches.forEach((unpatch) => {
                try { unpatch(); } catch {}
            });
            patches = [];
            translatedCache.clear();
            pendingIds.clear();
        }
    };
})();
