# 项目简介

## 名称

中文：**ChatGPT 小地图**  
英文：**ChatGPT Mini Map**  
建议仓库名：`chatgpt-minimap`

## GitHub Description

为 ChatGPT 长对话添加小地图侧栏：问答目录、全文搜索、消息跳转与阅读定位。原生 JavaScript / Manifest V3，无需 API Key。

## 英文 Description（可选）

A lightweight Edge extension for navigating long ChatGPT conversations with a sidebar outline, text search, full-text reading, and message jumping. No API key required.

## 项目介绍

ChatGPT 小地图是一款面向 Microsoft Edge 的轻量浏览器扩展，帮助你在长对话中找到需要的提问和回答。它在聊天页面旁提供可独立滚动的目录，支持正文搜索、全文阅读、标题导航与消息跳转，并尝试为当前选中的对话分支建立完整索引。读取失败时会明确显示状态和诊断信息，不把局部消息伪装成完整对话。

项目使用原生 JavaScript、CSS 和 Manifest V3，无需构建或 API Key。对话数据保留在当前标签页内存中，不上传到第三方服务；可通过 Edge 开发人员模式加载。完整读取依赖 ChatGPT 页面与内部接口的兼容性。

## 建议 Topics

`chatgpt` · `edge-extension` · `browser-extension` · `manifest-v3` · `javascript` · `conversation-navigation`

## v1.2.2 首次公开发布说明（可复制）

ChatGPT 小地图的首次公开源码版本，面向 Edge 开发人员模式加载。

- 提供问答目录、当前分支索引、正文搜索、全文阅读与消息跳转。
- 支持深浅主题、字号调节、阅读位置跟随和本地偏好保存。
- 完善首次 404 的登录授权回退，以及可复制的错误诊断。
- 附带 README、MIT 许可证和贡献说明。

完整读取和跳转依赖 ChatGPT 的页面及内部接口，当前测试以隔离 Edge 中的模拟会话为主。下载源码后，选择包含 manifest.json 的目录加载；首次公开发布可先标记为 Pre-release 收集兼容性反馈。
