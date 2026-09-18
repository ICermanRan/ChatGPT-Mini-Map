"use strict";
const statusLabel = document.getElementById("status");
const toggle = document.getElementById("toggle");
let targetTabId;

async function connect() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("No active tab");
    targetTabId = tab.id;
    const state = await chrome.tabs.sendMessage(targetTabId, { type: "CGMAP_STATUS" });
    if (!state || typeof state.open !== "boolean") throw new Error("No minimap");
    showState(state);
    toggle.disabled = false;
  } catch {
    statusLabel.textContent = "请打开 ChatGPT 对话并刷新页面";
  }
}

function showState(state) {
  statusLabel.textContent = state.count > 0 ? `已连接 · ${state.count} 条消息${state.complete ? " · 完整索引" : ""}` : "已连接 · 等待对话内容";
  toggle.textContent = state.open ? "收起小地图" : "打开小地图";
}

toggle.addEventListener("click", async () => {
  try {
    const state = await chrome.tabs.sendMessage(targetTabId, { type: "CGMAP_TOGGLE" });
    if (state) showState(state);
  } catch {
    toggle.disabled = true;
    statusLabel.textContent = "连接已更新，请刷新 ChatGPT 页面";
  }
});
connect();
