(() => {
  const ROOT_ID = "webtranslate-root";
  const TRANSLATION_ATTRIBUTE = "data-webtranslate-translation";
  const BLOCK_SELECTOR = "p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,td,th,div,section,article";
  let root;
  let translationTaskId = 0;
  let activeRequestId;

  function getRoot() {
    if (root?.isConnected) return root;
    root = document.createElement("div");
    root.id = ROOT_ID;
    root.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      :host { all: initial; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      .wt-action { position: fixed; z-index: 2147483647; border: 0; border-radius: 6px; padding: 7px 10px; color: white; background: #2563eb; box-shadow: 0 3px 12px rgb(0 0 0 / 20%); cursor: pointer; white-space: nowrap; }
      .wt-action:disabled { background: #64748b; cursor: wait; }
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
    translationTaskId += 1;
    activeRequestId = undefined;
    if (requestId !== undefined) cancelBackgroundRequest(requestId);
    const button = getRoot().shadowRoot.querySelector(".wt-action");
    button?.remove();
    document.querySelectorAll(`[${TRANSLATION_ATTRIBUTE}][data-task-id="${requestId}"]`).forEach((host) => {
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
      .dismiss { display: inline; margin: 0 0 0 4px; padding: 0 2px; border: 0; background: transparent; color: #8793aa; font-family: inherit; font-size: 12px; line-height: 1; opacity: .6; cursor: pointer; vertical-align: baseline; }
      .dismiss:hover { color: #465a85; opacity: 1; }
    `;
    const content = document.createElement("div");
    content.className = "translation";
    const result = document.createElement("span");
    result.className = "result";
    const dismiss = document.createElement("button");
    dismiss.className = "dismiss";
    dismiss.type = "button";
    dismiss.textContent = "×";
    dismiss.setAttribute("aria-label", "隐藏这段译文");
    dismiss.addEventListener("click", () => host.remove());
    content.append(result, dismiss);
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

  function updateParagraph(paragraph, statusText, translation = "") {
    const shadow = paragraph.host?.shadowRoot;
    if (!shadow) return;
    const result = shadow.querySelector(".result");
    // 翻译中和成功时保持界面安静，只在失败时显示必要错误信息。
    result.textContent = statusText.startsWith("翻译失败：") ? statusText : translation;
  }

  async function startTranslation(segments) {
    const taskId = ++translationTaskId;
    const isCurrentTask = () => taskId === translationTaskId;
    const previousRequestId = activeRequestId;
    activeRequestId = undefined;
    if (previousRequestId !== undefined) cancelBackgroundRequest(previousRequestId);

    const paragraphs = segments.map(({ element, sourceText }, index) => ({
      id: `paragraph-${taskId}-${index + 1}`,
      element,
      sourceText,
      status: "pending",
      translatedText: ""
    }));
    paragraphs.forEach((paragraph) => createTranslationHost(paragraph, taskId));

    const shadow = getRoot().shadowRoot;
    const button = shadow.querySelector(".wt-action");
    if (button) {
      button.dataset.mode = "running";
      button.textContent = "取消翻译";
      button.disabled = false;
      button.onclick = cancelTranslation;
    }

    // 采用小批次请求，减少请求次数并限制单次上下文长度。
    const batchSize = 5;
    for (let start = 0; start < paragraphs.length && isCurrentTask(); start += batchSize) {
      const batch = paragraphs.slice(start, start + batchSize);
      batch.forEach((paragraph) => updateParagraph(paragraph, "翻译中……"));
      try {
        activeRequestId = taskId;
        const response = await chrome.runtime.sendMessage({
          type: "TRANSLATE_BATCH",
          paragraphs: batch.map(({ id, sourceText }) => ({ id, text: sourceText })),
          requestId: taskId
        });
        if (activeRequestId === taskId) activeRequestId = undefined;
        if (!isCurrentTask()) return;
        if (!response?.ok) throw new Error(response?.error || "翻译请求失败");
        if (!Array.isArray(response.translations)) throw new Error("翻译结果格式错误");
        const results = new Map(response.translations.map((item) => [item.id, item.text]));
        batch.forEach((paragraph) => {
          const translatedText = results.get(paragraph.id);
          if (typeof translatedText !== "string" || !translatedText.trim()) {
            throw new Error(`段落 ${paragraph.id} 没有返回有效译文`);
          }
          paragraph.status = "success";
          paragraph.translatedText = translatedText;
          updateParagraph(paragraph, "翻译完成", translatedText);
        });
      } catch (error) {
        if (!isCurrentTask()) return;
        if (activeRequestId === taskId) activeRequestId = undefined;
        batch.forEach((paragraph) => {
          paragraph.status = "failed";
          updateParagraph(paragraph, `翻译失败：${error.message}`);
        });
      }
    }

    if (!isCurrentTask()) return;
    activeRequestId = undefined;
    if (button?.isConnected) {
      button.remove();
    }
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
})();
