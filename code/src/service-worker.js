const DEFAULT_CONFIG = {
  endpoint: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-4o-mini",
  targetLanguage: "简体中文",
  style: "自然表达",
  customStylePrompt: "优先使用自然、地道、简洁的中文表达，避免逐词直译和生硬措辞。保留原意、语气和信息，不擅自增删。",
  contextEnabled: true,
  timeoutMs: 60000
};
const activeRequests = new Map();
const CACHE_DB_NAME = "webtranslate-translation-cache";
const CACHE_STORE_NAME = "translations";
const CACHE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 1000;
const TRANSLATION_PROMPT_VERSION = 2;
let cacheDatabasePromise;

/** 右键菜单提供常用目标语言；默认翻译项始终使用设置页中的目标语言。 */
const CONTEXT_MENU_LANGUAGES = [
  "简体中文", "繁體中文", "English", "日本語", "한국어", "Français",
  "Deutsch", "Español", "Português", "Italiano", "Русский", "العربية",
  "हिन्दी", "ไทย", "Tiếng Việt", "Bahasa Indonesia", "Türkçe", "Nederlands",
  "Polski", "Українська", "עברית", "Svenska"
];
const CONTEXT_MENU_DEFAULT_ID = "webtranslate-translate-default";
const CONTEXT_MENU_PARENT_ID = "webtranslate-translate-to";
const CONTEXT_MENU_LANGUAGE_PREFIX = "webtranslate-translate-language-";

function getRequestKey(sender, requestId) {
  return `${sender.tab?.id ?? "no-tab"}:${sender.frameId ?? 0}:${requestId}`;
}

/**
 * 读取翻译配置。配置保存在扩展自己的 storage 中，避免把密钥暴露给网页上下文。
 */
async function getConfig() {
  const stored = await chrome.storage.local.get(DEFAULT_CONFIG);
  return { ...DEFAULT_CONFIG, ...stored };
}

/** 重建默认目标语言快捷项和“翻译为”子菜单。 */
async function rebuildContextMenus() {
  const config = await getConfig();
  await new Promise((resolve) => chrome.contextMenus.removeAll(resolve));
  chrome.contextMenus.create({
    id: CONTEXT_MENU_DEFAULT_ID,
    title: `翻译为${config.targetLanguage}`,
    contexts: ["selection"],
    visible: true
  });
  chrome.contextMenus.create({
    id: CONTEXT_MENU_PARENT_ID,
    title: "翻译为",
    contexts: ["selection"]
  });
  CONTEXT_MENU_LANGUAGES.forEach((language, index) => {
    chrome.contextMenus.create({
      id: `${CONTEXT_MENU_LANGUAGE_PREFIX}${index}`,
      parentId: CONTEXT_MENU_PARENT_ID,
      title: language,
      contexts: ["selection"]
    });
  });
}

function initializeContextMenus() {
  rebuildContextMenus().catch(() => {
    // 菜单注册失败不应影响扩展其他功能；浏览器下次启动或设置变化时会再次尝试。
  });
}

chrome.runtime.onInstalled.addListener(initializeContextMenus);
chrome.runtime.onStartup.addListener(initializeContextMenus);
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes.targetLanguage) initializeContextMenus();
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;
  try {
    let targetLanguage;
    if (info.menuItemId === CONTEXT_MENU_DEFAULT_ID) {
      targetLanguage = (await getConfig()).targetLanguage;
    } else if (typeof info.menuItemId === "string" && info.menuItemId.startsWith(CONTEXT_MENU_LANGUAGE_PREFIX)) {
      const index = Number(info.menuItemId.slice(CONTEXT_MENU_LANGUAGE_PREFIX.length));
      targetLanguage = CONTEXT_MENU_LANGUAGES[index];
    }
    if (!targetLanguage) return;
    await chrome.tabs.sendMessage(
      tab.id,
      { type: "TRANSLATE_SELECTION", targetLanguage },
      { frameId: info.frameId }
    );
  } catch {
    // 浏览器内置页面等不允许注入内容脚本，忽略无法翻译的右键操作。
  }
});

/** 接受 API 基础地址，并兼容旧设置中误填的 /chat/completions 完整路径。 */
function normalizeApiBaseUrl(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("接口地址必须使用 HTTP 或 HTTPS");
  url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/chat\/completions$/, "") || "/";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function getApiUrl(baseUrl, resourcePath) {
  return `${normalizeApiBaseUrl(baseUrl)}/${resourcePath}`;
}

async function listModels(endpointValue, apiKey) {
  if (!apiKey) throw new Error("请先填写 API Key");
  let modelsUrl;
  try {
    modelsUrl = getApiUrl(endpointValue, "models");
  } catch {
    throw new Error("请输入有效的 API 基础地址");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(modelsUrl, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 180);
      throw new Error(`获取模型列表失败（${response.status}）：${detail}`);
    }
    const result = await response.json();
    const models = Array.isArray(result.data)
      ? result.data.map((item) => item?.id).filter((id) => typeof id === "string" && id.trim())
      : [];
    if (!models.length) throw new Error("服务没有返回可用模型列表，可直接手动输入模型名称");
    return [...new Set(models)].sort((left, right) => left.localeCompare(right));
  } catch (error) {
    if (error.name === "AbortError") throw new Error("获取模型列表超时");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/** 打开扩展专属 IndexedDB，避免把大量译文塞进有配额限制的 sync/local 配置区。 */
function openCacheDatabase() {
  if (!cacheDatabasePromise) {
    cacheDatabasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(CACHE_DB_NAME, 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(CACHE_STORE_NAME)) {
          database.createObjectStore(CACHE_STORE_NAME, { keyPath: "key" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("无法打开翻译缓存"));
      request.onblocked = () => reject(new Error("翻译缓存正在被其他扩展页面占用"));
    }).catch((error) => {
      cacheDatabasePromise = undefined;
      throw error;
    });
  }
  return cacheDatabasePromise;
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("缓存事务失败"));
    transaction.onabort = () => reject(transaction.error || new Error("缓存事务已中止"));
  });
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("缓存读取失败"));
  });
}

/** 缓存键包含所有会改变译文的设置和原文，但不包含 API Key。 */
async function createCacheKey(sourceText, config, contextBefore = "", contextAfter = "") {
  const identity = JSON.stringify({
    promptVersion: TRANSLATION_PROMPT_VERSION,
    endpoint: normalizeApiBaseUrl(config.endpoint),
    model: config.model.trim(),
    targetLanguage: config.targetLanguage.trim(),
    style: config.style.trim(),
    customStylePrompt: (config.customStylePrompt || "").trim(),
    contextEnabled: Boolean(config.contextEnabled),
    contextBefore: config.contextEnabled ? contextBefore : "",
    contextAfter: config.contextEnabled ? contextAfter : "",
    sourceText
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readCachedTranslation(key) {
  try {
    const database = await openCacheDatabase();
    const transaction = database.transaction(CACHE_STORE_NAME, "readonly");
    const done = transactionDone(transaction);
    const entry = await requestResult(transaction.objectStore(CACHE_STORE_NAME).get(key));
    await done;
    if (!entry) return null;
    if (Date.now() - entry.cachedAt > CACHE_TTL_MS) {
      await deleteCachedTranslation(key);
      return null;
    }
    return entry.translation;
  } catch {
    // 缓存不可用时仍继续翻译，缓存属于加速能力，不应阻断核心流程。
    return null;
  }
}

async function deleteCachedTranslation(key) {
  const database = await openCacheDatabase();
  const transaction = database.transaction(CACHE_STORE_NAME, "readwrite");
  const done = transactionDone(transaction);
  transaction.objectStore(CACHE_STORE_NAME).delete(key);
  await done;
}

/** 写入成功译文，并将缓存数量限制在最近使用的 1000 条以内。 */
async function writeCachedTranslations(entries) {
  try {
    const database = await openCacheDatabase();
    const transaction = database.transaction(CACHE_STORE_NAME, "readwrite");
    const done = transactionDone(transaction);
    const store = transaction.objectStore(CACHE_STORE_NAME);
    const now = Date.now();
    entries.forEach(({ key, translation }) => store.put({ key, translation, cachedAt: now }));
    await done;

    const countTransaction = database.transaction(CACHE_STORE_NAME, "readonly");
    const countDone = transactionDone(countTransaction);
    const count = await requestResult(countTransaction.objectStore(CACHE_STORE_NAME).count());
    await countDone;
    if (count <= MAX_CACHE_ENTRIES) return;

    const readTransaction = database.transaction(CACHE_STORE_NAME, "readonly");
    const readDone = transactionDone(readTransaction);
    const allEntries = await requestResult(readTransaction.objectStore(CACHE_STORE_NAME).getAll());
    await readDone;
    allEntries.sort((left, right) => left.cachedAt - right.cachedAt);
    const removeCount = allEntries.length - MAX_CACHE_ENTRIES;
    const pruneTransaction = database.transaction(CACHE_STORE_NAME, "readwrite");
    const pruneDone = transactionDone(pruneTransaction);
    allEntries.slice(0, removeCount).forEach((entry) => pruneTransaction.objectStore(CACHE_STORE_NAME).delete(entry.key));
    await pruneDone;
  } catch {
    // 缓存写入失败不影响本次已取得的翻译结果。
  }
}

async function clearTranslationCache() {
  const database = await openCacheDatabase();
  const transaction = database.transaction(CACHE_STORE_NAME, "readwrite");
  const done = transactionDone(transaction);
  transaction.objectStore(CACHE_STORE_NAME).clear();
  await done;
}

/**
 * 将一批段落发送给 OpenAI 兼容的 Chat Completions 接口。
 * 要求模型返回 JSON，借此确保段落 ID 和顺序不会因为模型自由发挥而丢失。
 */
async function translateBatch(paragraphs, signal, requestedTargetLanguage) {
  const storedConfig = await getConfig();
  // 右键“翻译为”只覆盖本次请求配置，不写回用户保存的默认目标语言。
  const config = {
    ...storedConfig,
    targetLanguage: typeof requestedTargetLanguage === "string" && requestedTargetLanguage.trim()
      ? requestedTargetLanguage.trim()
      : storedConfig.targetLanguage
  };
  if (!config.model) {
    throw new Error("请先配置模型名称");
  }
  let endpoint;
  try {
    endpoint = getApiUrl(config.endpoint, "chat/completions");
  } catch {
    throw new Error("接口地址必须是有效的 HTTP 或 HTTPS 地址");
  }

  const cacheKeys = await Promise.all(paragraphs.map(async (paragraph) => ({
    id: paragraph.id,
    key: await createCacheKey(paragraph.text, config, paragraph.contextBefore, paragraph.contextAfter)
  })));
  const cacheKeyById = new Map(cacheKeys.map(({ id, key }) => [id, key]));
  const cachedByKey = new Map();
  const uniqueKeys = [...new Set(cacheKeys.map(({ key }) => key))];
  for (const key of uniqueKeys) cachedByKey.set(key, await readCachedTranslation(key));

  const uncachedByKey = new Map();
  for (const paragraph of paragraphs) {
    const cacheKey = cacheKeyById.get(paragraph.id);
    if (!cachedByKey.get(cacheKey) && !uncachedByKey.has(cacheKey)) {
      uncachedByKey.set(cacheKey, { ...paragraph, cacheKey });
    }
  }
  const uncachedParagraphs = [...uncachedByKey.values()];
  if (uncachedParagraphs.length === 0) {
    return paragraphs.map(({ id }) => ({ id, text: cachedByKey.get(cacheKeyById.get(id)) }));
  }
  if (!config.apiKey) {
    throw new Error("请先在插件设置中配置 API Key");
  }

  // 用短且稳定的批内 ID 降低模型漏写、重复或改写长 ID 的概率；缓存映射仍使用原段落 ID。
  const requestParagraphs = uncachedParagraphs.map((paragraph, index) => ({
    ...paragraph,
    originalId: paragraph.id,
    id: `p${index + 1}`
  }));

  const payload = {
    model: config.model,
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content: [
          "你是专业网页翻译助手。",
          `请将每个段落翻译成${config.targetLanguage}，翻译风格为${config.style}。`,
          "自动识别每个待翻译段落的原文语言，再翻译成目标语言；不要输出语言识别结果。",
          "先理解句子在上下文中的真实含义，再用目标语言母语者自然、顺畅的表达重写；避免逐词对照、直译腔、不必要的名词化和生硬措辞。",
          "保留原文语气和信息，不擅自增删内容；品牌名、产品名和人名通常保留原文。",
          config.style === "自然表达"
            ? "自然表达优先保证读起来地道，而不是保留英文句式；习语和隐喻按语境转换成目标语言常用说法。"
            : config.style === "忠实准确" || config.style === "忠实直译"
              ? "忠实准确应贴近原文信息和结构，但仍须符合目标语言语法，不能逐词硬译。"
              : config.style === "技术文档"
                ? "技术文档风格应准确、简洁、术语一致，并保留必要的技术名称。"
                : "按所选风格和用户提供的补充要求执行。",
          config.customStylePrompt?.trim()
            ? `用户补充的翻译风格要求：\n${config.customStylePrompt.trim()}`
            : "",
          config.contextEnabled
            ? "每个段落可能附带 contextBefore 和 contextAfter，它们仅用于理解指代、术语和语气；只翻译该段落自己的 text，不要翻译、重复或合并上下文。"
            : "",
          config.targetLanguage.includes("中文")
            ? "中文翻译应自然简洁。例如创作语境中的 stay in flow 可译为‘保持创作节奏’或‘不被打断’，不要机械译为‘保持心流’；built a product/app 通常译为‘开发了/做出了’，不要生硬译为‘构建了’。"
            : "",
          "必须原样保留短 id（如 p1、p2），不合并、不拆分、不改变段落顺序。",
          "只返回 JSON，格式必须是 {\"translations\":[{\"id\":\"段落id\",\"text\":\"译文\"}]}。",
          "不要输出 Markdown 代码块、解释或额外字段。"
        ].join("\n")
      },
      {
        role: "user",
        content: JSON.stringify({
          paragraphs: requestParagraphs.map(({ id, text, contextBefore, contextAfter }) => ({
            id,
            text,
            ...(config.contextEnabled ? { contextBefore, contextAfter } : {})
          }))
        })
      }
    ]
  };

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    signal.abort();
  }, config.timeoutMs);
  try {
    const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`
        },
        body: JSON.stringify(payload),
        signal: signal.signal
      });

    if (!response.ok) {
      // 错误响应体也在超时保护内读取，并限制展示长度，避免错误信息过大。
      const errorText = (await response.text()).slice(0, 200);
      throw new Error(`模型请求失败（${response.status}）：${errorText}`);
    }

    // 在同一个超时窗口内完成响应体读取和 JSON 解析，避免只限制到响应头。
    const result = await response.json();
    const wireTranslations = parseTranslationResponse(result, requestParagraphs);
    const originalIdByWireId = new Map(requestParagraphs.map(({ id, originalId }) => [id, originalId]));
    const freshTranslations = wireTranslations.map(({ id, text }) => ({
      id: originalIdByWireId.get(id),
      text
    }));
    const keyById = new Map(uncachedParagraphs.map(({ id, cacheKey }) => [id, cacheKey]));
    freshTranslations.forEach(({ id, text }) => {
      cachedByKey.set(keyById.get(id), text);
    });
    await writeCachedTranslations(freshTranslations.map(({ id, text }) => ({
      key: keyById.get(id),
      translation: text
    })));
    return paragraphs.map(({ id }) => ({ id, text: cachedByKey.get(cacheKeyById.get(id)) }));
  } catch (error) {
    if (timedOut || error.name === "AbortError") {
      throw new Error("模型请求超时，请检查接口地址或网络连接");
    }
    throw new Error(`模型请求失败：${error.message}`);
  } finally {
    clearTimeout(timeout);
  }
}

/** 校验模型响应并确保每个请求段落都有且只有一个有效译文。 */
function parseTranslationResponse(result, paragraphs) {
  const rawContent = result.choices?.[0]?.message?.content;
  const content = typeof rawContent === "string"
    ? rawContent
    : Array.isArray(rawContent)
      ? rawContent.map((part) => part?.text || "").join("")
      : "";
  if (!content) {
    throw new Error("模型没有返回有效翻译结果");
  }

  let parsed;
  try {
    // 兼容模型偶尔返回 ```json ... ``` 的情况，同时不依赖 response_format。
    const jsonText = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error("模型返回内容不是有效 JSON");
  }

  if (!Array.isArray(parsed.translations)) {
    throw new Error("模型返回结果缺少 translations 数组");
  }
  const expectedIds = paragraphs.map((paragraph) => paragraph.id);
  const expectedIdSet = new Set(expectedIds);
  const translationsById = new Map();
  let allItemsWellFormed = true;
  for (const item of parsed.translations) {
    if (!item || typeof item.id !== "string" || typeof item.text !== "string" || !item.text.trim()) {
      allItemsWellFormed = false;
      continue;
    }
    // 只收集本次请求的 ID；重复 ID 和模型额外编造的记录不覆盖有效译文。
    if (expectedIdSet.has(item.id) && !translationsById.has(item.id)) {
      translationsById.set(item.id, item.text.trim());
    }
  }

  if (translationsById.size === expectedIds.length) {
    return expectedIds.map((id) => ({ id, text: translationsById.get(id) }));
  }

  // ID 格式不规范时，仅在记录数量完全相等且字段有效时才按位置兜底；数量不等不能安全猜测对应关系。
  if (parsed.translations.length === expectedIds.length && allItemsWellFormed) {
    return parsed.translations.map((item, index) => ({
      id: expectedIds[index],
      text: item.text.trim()
    }));
  }

  const missingIds = expectedIds.filter((id) => !translationsById.has(id));
  throw new Error(`模型未能可靠返回全部段落，缺少 ${missingIds.join(", ") || "有效译文"}`);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !["TRANSLATE_BATCH", "CANCEL_TRANSLATION", "CLEAR_TRANSLATION_CACHE", "LIST_MODELS", "SET_DEFAULT_TRANSLATE_MENU_VISIBILITY"].includes(message.type)) {
    return false;
  }

  if (message.type === "SET_DEFAULT_TRANSLATE_MENU_VISIBILITY") {
    if (sender.id !== chrome.runtime.id || !sender.tab || typeof message.visible !== "boolean") {
      sendResponse({ ok: false, error: "无权更新右键菜单状态" });
      return false;
    }
    chrome.contextMenus.update(CONTEXT_MENU_DEFAULT_ID, { visible: message.visible }, () => {
      const error = chrome.runtime.lastError;
      sendResponse(error ? { ok: false, error: error.message } : { ok: true });
    });
    return true;
  }

  if (message.type === "LIST_MODELS") {
    // 仅管理页可枚举模型，避免网页内容脚本利用该消息发起跨域请求。
    if (sender.url !== chrome.runtime.getURL("src/options.html")) {
      sendResponse({ ok: false, error: "无权获取模型列表" });
      return false;
    }
    listModels(message.endpoint, message.apiKey)
      .then((models) => sendResponse({ ok: true, models }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "CLEAR_TRANSLATION_CACHE") {
    clearTranslationCache()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  const requestKey = getRequestKey(sender, message.requestId);
  if (message.type === "CANCEL_TRANSLATION") {
    activeRequests.get(requestKey)?.abort();
    sendResponse({ ok: true });
    return false;
  }
  if (!Array.isArray(message.paragraphs) || typeof message.requestId !== "number") {
    sendResponse({ ok: false, error: "翻译请求参数无效" });
    return false;
  }

  const controller = new AbortController();
  activeRequests.set(requestKey, controller);
  translateBatch(message.paragraphs, controller, message.targetLanguage)
    .then((translations) => sendResponse({ ok: true, translations }))
    .catch((error) => sendResponse({ ok: false, error: error.message }))
    .finally(() => {
      if (activeRequests.get(requestKey) === controller) activeRequests.delete(requestKey);
    });

  return true;
});
