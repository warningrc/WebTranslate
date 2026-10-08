(() => {
  const ROOT_ID = "webtranslate-root";
  const TRANSLATION_ATTRIBUTE = "data-webtranslate-translation";
  const BLOCK_SELECTOR = "p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,td,th,div,section,article";
  let root;
  let translationTaskId = 0;
  let currentTaskHostId;
  let activeRequestId;
  let taskInProgress = false;

  function getRoot() {
    if (root?.isConnected) return root;
    root = document.createElement("div");
    root.id = ROOT_ID;
    root.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      :host { all: initial; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      .wt-action { position: fixed; z-index: 2147483647; border: 0; border-radius: 6px; padding: 7px 10px; color: white; background: #2563eb; box-shadow: 0 3px 12px rgb(0 0 0 / 20%); cursor: pointer; white-space: nowrap; }
    `;
    root.shadowRoot.appendChild(style);
    document.documentElement.appendChild(root);
    return root;
  }

  function cancelBackgroundRequest(requestId) {
    chrome.runtime.sendMessage({ type: "CANCEL_TRANSLATION", requestId }).catch(() => {});
  }

  function cancelTranslation() {
    const requestId = activeRequestId;
    const taskHostId = currentTaskHostId;
    translationTaskId += 1;
    activeRequestId = undefined;
    taskInProgress = false;
    if (requestId !== undefined) cancelBackgroundRequest(requestId);
    getRoot().shadowRoot.querySelectorAll(".wt-action").forEach((node) => node.remove());
    document.querySelectorAll(`.wt-pending-indicator[data-task-id="${taskHostId}"]`).forEach((node) => node.remove());
    removeEmptyHostsForTask(taskHostId);
    enableFailedParagraphRetries();
  }

  function clearPageTranslations() {
    const requestId = activeRequestId;
    translationTaskId += 1;
    activeRequestId = undefined;
    taskInProgress = false;
    currentTaskHostId = undefined;
    if (requestId !== undefined) cancelBackgroundRequest(requestId);
    document.querySelectorAll(".wt-pending-indicator").forEach((node) => node.remove());
    // 清除插件插入的完整节点，连同译文、重试入口和叉号一起移除，恢复网页原状。
    document.querySelectorAll(`[${TRANSLATION_ATTRIBUTE}]`).forEach((host) => host.remove());
    getRoot().shadowRoot.querySelectorAll(".wt-action").forEach((node) => node.remove());
  }

  /** 新任务取代旧任务时，仅移除旧任务尚无译文的占位，保留已完成译文和失败重试入口。 */
  function removeEmptyHostsForTask(taskId) {
    if (taskId === undefined) return;
    document.querySelectorAll(`.wt-pending-indicator[data-task-id="${taskId}"]`).forEach((node) => node.remove());
    document.querySelectorAll(`[${TRANSLATION_ATTRIBUTE}][data-task-id="${taskId}"]`).forEach((host) => {
      if (!host.shadowRoot?.querySelector(".result")?.textContent) host.remove();
    });
  }

  /** 复制并裁剪选区与单个网页块的交集，仅把用户实际选中的文字作为翻译输入。 */
  function getTextInRange(element, selectionRange) {
    const elementRange = document.createRange();
    elementRange.selectNodeContents(element);
    const clippedRange = elementRange.cloneRange();
    if (selectionRange.compareBoundaryPoints(Range.START_TO_START, elementRange) > 0) {
      clippedRange.setStart(selectionRange.startContainer, selectionRange.startOffset);
    }
    if (selectionRange.compareBoundaryPoints(Range.END_TO_END, elementRange) < 0) {
      clippedRange.setEnd(selectionRange.endContainer, selectionRange.endOffset);
    }
    return clippedRange.toString().replace(/\s+/g, " ").trim();
  }

  /**
   * 将选区映射到网页中最内层的段落级块元素。优先采用网页真实 DOM 边界，
   * 比仅凭换行拆文本更可靠，也能让每段译文紧跟对应的原文块。
   */
  function getSelectedSegments(selectionRange, selectedText) {
    let scope = selectionRange.commonAncestorContainer;
    if (scope.nodeType !== Node.ELEMENT_NODE) scope = scope.parentElement;
    if (!scope) return [];

    const candidates = [];
    if (scope.matches?.(BLOCK_SELECTOR)) candidates.push(scope);
    candidates.push(...scope.querySelectorAll(BLOCK_SELECTOR));

    const intersecting = candidates
      .filter((element) => !element.closest(`#${ROOT_ID}`) && selectionRange.intersectsNode(element))
      .map((element) => ({ element, sourceText: getTextInRange(element, selectionRange) }))
      .filter((segment) => segment.sourceText.length > 0);
    const leaves = intersecting.filter(({ element }) =>
      !intersecting.some((other) => other.element !== element && element.contains(other.element))
    );

    if (leaves.length) return leaves;

    // 对没有段落标签的纯文本选区保留为一个段落，避免猜测视觉换行就是语义段落。
    const startElement = selectionRange.startContainer.nodeType === Node.ELEMENT_NODE
      ? selectionRange.startContainer
      : selectionRange.startContainer.parentElement;
    const anchor = startElement?.closest(BLOCK_SELECTOR);
    return anchor ? [{ element: anchor, sourceText: selectedText }] : [];
  }

  function getSelectionData() {
    const selection = window.getSelection();
    const text = selection?.toString().trim();
    if (!text || text.length < 2 || !selection.rangeCount) return null;
    const range = selection.getRangeAt(0).cloneRange();
    const rect = range.getBoundingClientRect();
    const segments = getSelectedSegments(range, text);
    return segments.length ? { segments, rect } : null;
  }

  function showActionButton(data) {
    const shadow = getRoot().shadowRoot;
    shadow.querySelector(".wt-action")?.remove();
    const button = document.createElement("button");
    button.className = "wt-action";
    button.dataset.mode = "translate";
    button.textContent = `翻译选中内容（${data.segments.length} 段）`;
    button.style.left = `${Math.max(8, Math.min(data.rect.left, window.innerWidth - 190))}px`;
    button.style.top = `${Math.max(8, Math.min(data.rect.bottom + 6, window.innerHeight - 42))}px`;
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.onclick = () => startTranslation(data.segments);
    shadow.appendChild(button);
  }

  function removeExistingTranslation(element) {
    const isListOrCell = ["LI", "TD", "TH"].includes(element.tagName);
    if (isListOrCell) {
      element.querySelectorAll(`:scope > [${TRANSLATION_ATTRIBUTE}]`).forEach((node) => node.remove());
      return;
    }
    let sibling = element.nextElementSibling;
    while (sibling?.hasAttribute(TRANSLATION_ATTRIBUTE)) {
      const next = sibling.nextElementSibling;
      sibling.remove();
      sibling = next;
    }
  }

  /** 在原文块之后创建隔离样式的译文节点，模型文本通过 textContent 写入以避免 HTML 注入。 */
  function createTranslationHost(paragraph, taskId) {
    const host = document.createElement("div");
    host.setAttribute(TRANSLATION_ATTRIBUTE, "true");
    host.dataset.paragraphId = paragraph.id;
    host.dataset.taskId = String(taskId);
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      :host { all: initial; display: block !important; margin: 7px 0 14px !important; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important; }
      .translation { border-left: 2px solid #a9bdf5; padding: 1px 0 1px 10px; color: #33466d; font-size: 0.96em; line-height: 1.65; overflow-wrap: anywhere; }
      .result { white-space: pre-wrap; }
      .actions { display: inline-flex; align-items: baseline; gap: 5px; margin-left: 4px; }
      .retry { padding: 0; border: 0; background: transparent; color: #5473c9; font-family: inherit; font-size: 11px; cursor: pointer; }
      .retry[hidden] { display: none; }
      .dismiss { padding: 0 2px; border: 0; background: transparent; color: #8793aa; font-family: inherit; font-size: 12px; line-height: 1; opacity: .6; cursor: pointer; vertical-align: baseline; }
      .dismiss:hover { color: #465a85; opacity: 1; }
    `;
    const content = document.createElement("div");
    content.className = "translation";
    const result = document.createElement("span");
    result.className = "result";
    const actions = document.createElement("span");
    actions.className = "actions";
    const retry = document.createElement("button");
    retry.className = "retry";
    retry.type = "button";
    retry.textContent = "重试";
    retry.hidden = true;
    retry.disabled = taskInProgress;
    retry.addEventListener("click", () => retryParagraph(paragraph));
    const dismiss = document.createElement("button");
    dismiss.className = "dismiss";
    dismiss.type = "button";
    dismiss.textContent = "×";
    dismiss.setAttribute("aria-label", "隐藏这段译文");
    dismiss.addEventListener("click", () => host.remove());
    actions.append(retry, dismiss);
    content.append(result, actions);
    shadow.append(style, content);

    const element = paragraph.element;
    removeExistingTranslation(element);
    if (["LI", "TD", "TH"].includes(element.tagName)) {
      element.appendChild(host);
    } else {
      element.parentNode?.insertBefore(host, element.nextSibling);
    }
    paragraph.host = host;
  }

  /** 请求期间只在原文段尾显示小型指示器，不创建空白译文块。 */
  function showPendingIndicator(paragraph) {
    if (paragraph.pendingIndicator?.isConnected) return;
    const indicator = document.createElement("span");
    indicator.className = "wt-pending-indicator";
    indicator.dataset.taskId = String(paragraph.taskId);
    indicator.setAttribute("aria-label", "正在翻译");
    indicator.style.cssText = "display:inline-flex;vertical-align:middle;margin-inline-start:6px;";
    const shadow = indicator.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      span { display:inline-block; width:10px; height:10px; box-sizing:border-box; border:1.5px solid #cbd5e1; border-top-color:#647fce; border-radius:50%; animation:wt-spin .7s linear infinite; }
      @keyframes wt-spin { to { transform:rotate(360deg); } }
    `;
    const spinner = document.createElement("span");
    shadow.append(style, spinner);
    paragraph.element.appendChild(indicator);
    paragraph.pendingIndicator = indicator;
  }

  function hidePendingIndicator(paragraph) {
    paragraph.pendingIndicator?.remove();
    paragraph.pendingIndicator = undefined;
  }

  function updateParagraph(paragraph, statusText, translation = "") {
    const shadow = paragraph.host?.shadowRoot;
    if (!shadow) return;
    const result = shadow.querySelector(".result");
    const retry = shadow.querySelector(".retry");
    // 成功时只显示译文；失败时显示错误和单段重试入口，翻译中不插入冗余状态文案。
    const failed = statusText.startsWith("翻译失败：");
    result.textContent = failed ? statusText : translation;
    retry.hidden = !failed;
    retry.disabled = taskInProgress;
  }

  async function runTranslationBatch(paragraphs, requestId) {
    activeRequestId = requestId;
    const response = await chrome.runtime.sendMessage({
      type: "TRANSLATE_BATCH",
      paragraphs: paragraphs.map(({ id, sourceText, contextBefore, contextAfter }) => ({
        id,
        text: sourceText,
        contextBefore,
        contextAfter
      })),
      requestId,
      targetLanguage: paragraphs[0]?.targetLanguage
    });
    if (activeRequestId === requestId) activeRequestId = undefined;
    // 取消或被新任务取代后，丢弃迟到的响应，避免旧译文覆盖新状态。
    if (requestId !== translationTaskId) return;
    if (!response?.ok) throw new Error(response?.error || "翻译请求失败");
    if (!Array.isArray(response.translations)) throw new Error("翻译结果格式错误");
    const results = new Map(response.translations.map((item) => [item.id, item.text]));
    paragraphs.forEach((paragraph) => {
      const translatedText = results.get(paragraph.id);
      if (typeof translatedText !== "string" || !translatedText.trim()) {
        throw new Error("模型没有返回有效译文");
      }
      paragraph.status = "success";
      paragraph.translatedText = translatedText;
      hidePendingIndicator(paragraph);
      if (!paragraph.host) createTranslationHost(paragraph, paragraph.taskId);
      updateParagraph(paragraph, "翻译完成", translatedText);
    });
  }

  async function retryParagraph(paragraph) {
    if (taskInProgress) return;
    const requestId = ++translationTaskId;
    currentTaskHostId = requestId;
    const previousRequestId = activeRequestId;
    activeRequestId = undefined;
    if (previousRequestId !== undefined) cancelBackgroundRequest(previousRequestId);
    taskInProgress = true;
    paragraph.host.dataset.taskId = String(requestId);
    paragraph.taskId = requestId;
    showPendingIndicator(paragraph);
    paragraph.status = "pending";
    // 保留上一次错误文字，直到重试成功或失败，取消重试时用户仍可再次操作。
    try {
      await runTranslationBatch([paragraph], requestId);
      if (requestId !== translationTaskId) return;
      taskInProgress = false;
      enableFailedParagraphRetries();
    } catch (error) {
      if (requestId !== translationTaskId) return;
      activeRequestId = undefined;
      taskInProgress = false;
      paragraph.status = "failed";
      hidePendingIndicator(paragraph);
      updateParagraph(paragraph, `翻译失败：${error.message}`);
      enableFailedParagraphRetries();
    }
  }

  async function startTranslation(segments, targetLanguage) {
    const taskId = ++translationTaskId;
    const isCurrentTask = () => taskId === translationTaskId;
    const previousTaskHostId = currentTaskHostId;
    currentTaskHostId = taskId;
    taskInProgress = true;
    const previousRequestId = activeRequestId;
    activeRequestId = undefined;
    if (previousRequestId !== undefined) cancelBackgroundRequest(previousRequestId);
    removeEmptyHostsForTask(previousTaskHostId);

    const preferences = await chrome.storage.local.get({ contextEnabled: true });
    if (!isCurrentTask()) return;
    const contextEnabled = preferences.contextEnabled !== false;
    const paragraphs = segments.map(({ element, sourceText }, index) => ({
      id: `paragraph-${taskId}-${index + 1}`,
      element,
      sourceText,
      taskId,
      targetLanguage,
      contextBefore: contextEnabled && index > 0 ? segments[index - 1].sourceText : "",
      contextAfter: contextEnabled && index + 1 < segments.length ? segments[index + 1].sourceText : "",
      status: "pending",
      translatedText: ""
    }));
    // 整个选区已进入翻译任务，先为所有段落显示提示，明确包含尚在队列中的段落。
    paragraphs.forEach(showPendingIndicator);
    const shadow = getRoot().shadowRoot;
    const button = shadow.querySelector(".wt-action");
    button?.remove();

    // 采用小批次请求，减少请求次数并限制单次上下文长度。
    const batchSize = 5;
    for (let start = 0; start < paragraphs.length && isCurrentTask(); start += batchSize) {
      const batch = paragraphs.slice(start, start + batchSize);
      try {
        await runTranslationBatch(batch, taskId);
        if (!isCurrentTask()) return;
      } catch (error) {
        if (!isCurrentTask()) return;
        if (activeRequestId === taskId) activeRequestId = undefined;
        batch.forEach((paragraph) => {
          paragraph.status = "failed";
          hidePendingIndicator(paragraph);
          if (!paragraph.host) createTranslationHost(paragraph, taskId);
          updateParagraph(paragraph, `翻译失败：${error.message}`);
        });
      }
    }

    if (!isCurrentTask()) return;
    taskInProgress = false;
    activeRequestId = undefined;
    enableFailedParagraphRetries();
  }

  function enableFailedParagraphRetries() {
    document.querySelectorAll(`[${TRANSLATION_ATTRIBUTE}]`).forEach((host) => {
      const retry = host.shadowRoot?.querySelector(".retry");
      if (retry && !retry.hidden) retry.disabled = false;
    });
  }

  document.addEventListener("mouseup", (event) => {
    if (event.target.closest?.(`#${ROOT_ID}`)) return;
    const data = getSelectionData();
    if (data) {
      showActionButton(data);
    } else {
      hideTranslateButtonIfSelectionCleared();
    }
  });

  function hideTranslateButtonIfSelectionCleared() {
    const selectedText = window.getSelection()?.toString().trim();
    if (selectedText) return;
    const button = root?.shadowRoot?.querySelector('.wt-action[data-mode="translate"]');
    button?.remove();
  }

  // 选区也可能通过键盘取消或点击页面空白处清除，因此不能只依赖 mouseup。
  document.addEventListener("selectionchange", hideTranslateButtonIfSelectionCleared);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "TRANSLATE_SELECTION") {
      const selectionData = getSelectionData();
      if (!selectionData) {
        sendResponse({ ok: false, error: "请先选中要翻译的内容" });
        return false;
      }
      startTranslation(selectionData.segments, message.targetLanguage);
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type !== "CLEAR_PAGE_TRANSLATIONS") return false;
    clearPageTranslations();
    sendResponse({ ok: true });
    return false;
  });
})();
