document.getElementById("open-options").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

document.getElementById("clear-page").addEventListener("click", async () => {
  const status = document.getElementById("popup-status");
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("无法读取当前标签页");
    const response = await chrome.tabs.sendMessage(tab.id, { type: "CLEAR_PAGE_TRANSLATIONS" });
    if (!response?.ok) throw new Error("当前页面不支持此操作");
    status.textContent = "本次译文已清除";
  } catch {
    status.textContent = "当前页面无法清除译文";
  }
});
