const DEFAULT_SETTINGS = {
  endpoint: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-4o-mini",
  targetLanguage: "简体中文",
  style: "自然表达",
  customStylePrompt: "优先使用自然、地道、简洁的中文表达，避免逐词直译和生硬措辞。保留原意、语气和信息，不擅自增删。",
  contextEnabled: true
};
const STYLE_PRESETS = {
  "自然表达": "先理解原文含义，再用目标语言自然、地道、简洁地表达。避免逐词直译和生硬措辞，保留原意、语气和信息，不擅自增删。",
  "忠实准确": "准确保留原文的含义、语气、逻辑关系和细节，不遗漏、不增补。句式可以为目标语言的通顺度适当调整，但不要改写成意译或摘要。",
  "技术文档": "使用清晰、准确、简洁的技术表达。专业术语前后一致；产品名、代码、变量名和命令保持原样；保留步骤、条件、数字和格式。",
  "学术严谨": "使用客观、严谨、规范的学术表达。准确保留论点、限定条件、因果关系和不确定性，不夸大结论；专业术语和引用信息保持一致。",
  "商务专业": "使用得体、清楚、专业的商务表达。语气礼貌而直接，避免过度随意、夸张营销措辞和不必要的客套；准确保留承诺、时间、金额及责任边界。",
  "轻松口语": "使用自然、亲切、易懂的日常表达，像真实交流而不是书面报告。可以调整语序和习惯说法，但保留原意，不添加俚语或原文没有的情绪。"
};
const FIELDS = Object.keys(DEFAULT_SETTINGS);

/** 从扩展本地存储恢复设置；旧版本没有自定义风格时自动采用默认说明。 */
async function loadSettings() {
  const settings = await chrome.storage.local.get(DEFAULT_SETTINGS);
  settings.endpoint = normalizeEndpointForForm(settings.endpoint);
  const targetLanguage = document.getElementById("targetLanguage");
  // 保留旧版本中用户填写的非内置语言，避免升级后表单变空并意外覆盖配置。
  if (![...targetLanguage.options].some((option) => option.value === settings.targetLanguage)) {
    const legacyOption = document.createElement("option");
    legacyOption.value = settings.targetLanguage;
    legacyOption.textContent = `${settings.targetLanguage}（原自定义设置）`;
    targetLanguage.appendChild(legacyOption);
  }
  // 兼容旧版“忠实直译”配置，并将未知历史风格迁移到可编辑的自定义模式。
  if (settings.style === "忠实直译") settings.style = "忠实准确";
  const supportedStyles = [...Object.keys(STYLE_PRESETS), "自定义"];
  if (!supportedStyles.includes(settings.style)) settings.style = "自定义";
  FIELDS.forEach((field) => {
    const input = document.getElementById(field);
    if (input.type === "checkbox") input.checked = settings[field] ?? DEFAULT_SETTINGS[field];
    else input.value = settings[field] ?? DEFAULT_SETTINGS[field];
  });
}

/** 把旧版保存的完整 Chat Completions 地址转换成 API 基础地址显示。 */
function normalizeEndpointForForm(value) {
  try {
    const endpoint = new URL(value);
    endpoint.pathname = endpoint.pathname.replace(/\/+$/, "").replace(/\/chat\/completions$/, "") || "/";
    endpoint.search = "";
    endpoint.hash = "";
    return endpoint.toString().replace(/\/$/, "");
  } catch {
    return value || DEFAULT_SETTINGS.endpoint;
  }
}

/** 保存前校验必填项和协议，避免把明显无效的地址写入配置。 */
function validateSettings(settings) {
  let endpoint;
  try {
    endpoint = new URL(settings.endpoint);
  } catch {
    throw new Error("请输入有效的接口地址");
  }
  if (!['http:', 'https:'].includes(endpoint.protocol)) {
    throw new Error("接口地址必须使用 HTTP 或 HTTPS");
  }
  if (!settings.apiKey || !settings.model || !settings.targetLanguage) {
    throw new Error("请填写 API Key、模型名称和目标语言");
  }
}

document.getElementById("settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const status = document.getElementById("status");
  const settings = Object.fromEntries(FIELDS.map((field) => [
    field,
    document.getElementById(field).type === "checkbox"
      ? document.getElementById(field).checked
      : document.getElementById(field).value.trim()
  ]));
  try {
    settings.endpoint = normalizeEndpointForForm(settings.endpoint);
    validateSettings(settings);
    await chrome.storage.local.set(settings);
    status.textContent = "设置已保存";
  } catch (error) {
    status.textContent = error.message || `保存失败：${error}`;
  }
});

document.getElementById("toggle-key").addEventListener("click", (event) => {
  const keyInput = document.getElementById("apiKey");
  const visible = keyInput.type === "password";
  keyInput.type = visible ? "text" : "password";
  event.currentTarget.textContent = visible ? "隐藏" : "显示";
});

document.getElementById("clear-cache").addEventListener("click", async () => {
  const status = document.getElementById("status");
  try {
    const response = await chrome.runtime.sendMessage({ type: "CLEAR_TRANSLATION_CACHE" });
    if (!response?.ok) throw new Error(response?.error || "清空缓存失败");
    status.textContent = "本地翻译缓存已清空";
  } catch (error) {
    status.textContent = `清空缓存失败：${error.message}`;
  }
});

document.getElementById("style").addEventListener("change", (event) => {
  const presetPrompt = STYLE_PRESETS[event.currentTarget.value];
  if (presetPrompt) {
    // 切换内置风格时先载入推荐规则，用户仍可在文本框中继续编辑。
    document.getElementById("customStylePrompt").value = presetPrompt;
  }
});

const modelInput = document.getElementById("model");
const modelOptions = document.getElementById("model-options");
let availableModels = [];
let modelFetchInProgress = false;

function renderModelOptions() {
  const query = modelInput.value.trim().toLowerCase();
  const filtered = availableModels.filter((model) => model.toLowerCase().includes(query));
  modelOptions.replaceChildren();
  if (!filtered.length) {
    const empty = document.createElement("div");
    empty.className = "model-empty";
    empty.textContent = availableModels.length ? "没有匹配项，可继续手动输入。" : "没有模型列表，可手动输入模型名称。";
    modelOptions.appendChild(empty);
  } else {
    filtered.forEach((model) => {
      const option = document.createElement("button");
      option.type = "button";
      option.className = "model-option";
      option.setAttribute("role", "option");
      option.textContent = model;
      option.addEventListener("mousedown", (event) => event.preventDefault());
      option.addEventListener("click", () => {
        modelInput.value = model;
        modelOptions.hidden = true;
      });
      modelOptions.appendChild(option);
    });
  }
  modelOptions.hidden = false;
}

async function fetchAvailableModels() {
  if (modelFetchInProgress) return;
  modelFetchInProgress = true;
  const status = document.getElementById("status");
  status.textContent = "正在获取模型列表…";
  try {
    const response = await chrome.runtime.sendMessage({
      type: "LIST_MODELS",
      endpoint: document.getElementById("endpoint").value.trim(),
      apiKey: document.getElementById("apiKey").value.trim()
    });
    if (!response?.ok) throw new Error(response?.error || "获取模型列表失败");
    availableModels = response.models;
    status.textContent = `已获取 ${availableModels.length} 个模型`;
    renderModelOptions();
  } catch (error) {
    availableModels = [];
    status.textContent = error.message;
    renderModelOptions();
  } finally {
    modelFetchInProgress = false;
  }
}

modelInput.addEventListener("focus", fetchAvailableModels);
modelInput.addEventListener("input", () => {
  if (!modelOptions.hidden) renderModelOptions();
});
modelInput.addEventListener("keydown", (event) => {
  if (event.key === "Escape") modelOptions.hidden = true;
});
document.addEventListener("mousedown", (event) => {
  if (!event.target.closest(".model-picker")) modelOptions.hidden = true;
});

loadSettings().catch((error) => {
  document.getElementById("status").textContent = `读取设置失败：${error.message}`;
});
