/* ChatGPT Mini Map — conversation data stays in this tab memory only. */
(() => {
  'use strict';

  const HOST_ID = 'cgmap-root';
  const SETTINGS_KEY = 'cgmapSettings';
  if (document.getElementById(HOST_ID)) return;

  const defaults = { open: true, scope: 'all', depth: 2, follow: true, fontSize: 15 };
  let settings = { ...defaults };
  let entries = [];
  let activeId = '';
  let searchValue = '';
  let messageCount = 0;
  let scanTimer = 0;
  let positionFrame = 0;
  let saveTimer = 0;
  let lastLocation = location.href;
  let lastSignature = '';
  let lastFollowId = '';
  let isDestroyed = false;
  let scrollContainer = null;
  let mountedTargets = [];
  let locatorState = { legacy: 0, content: 0, matched: 0 };
  let locatorDebug = [];
  let nodeSequence = 0;
  const nodeIds = new WeakMap();
  let records = [];
  let complete = false;
  let loadState = 'loading';
  let loadError = '';
  let errorCode = '';
  let errorStage = '';
  let errorHttpStatus = null;
  let bridgeReady = false;
  let bridgeVersion = '';
  let bridgeRouteSupported = null;
  let requestAcknowledged = false;
  let requestStage = '';
  let bridgePingId = '';
  let bridgeTimer = 0;
  let lastSource = '';
  const extensionVersion = '1.3.5';
  let conversationId = '';
  let pendingRequest = null;
  let requestTimer = 0;
  let refreshTimer = 0;
  let refreshAfterPending = false;
  const pendingAddedIds = new Set();
  let routeGeneration = 0;
  let jumpController = null;
  let navigationError = null;
  let ignoredNodes = new Map();
  let lastMountedFingerprints = new Map();
  let manualListUntil = 0;
  let lastRequestAt = 0;
  const recordByDom = new WeakMap();
  const observedTexts = new Map();

  function debugHash(value) {
    let hash = 2166136261;
    for (const character of String(value || '')) {
      hash ^= character.codePointAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  function debugNode(node, role, candidates, record) {
    const content = node ? contentFor(node) : null;
    const text = textFor(content || node);
    const rect = node?.getBoundingClientRect?.();
    const attrs = ['data-message-author-role', 'data-message-id', 'data-message-uuid', 'data-chatgpt-search-unit-key', 'data-chatgpt-search-message-ids', 'data-turn', 'data-testid'];
    return {
      role, tag: node?.tagName || null, attributes: attrs.filter(name => node?.hasAttribute?.(name)),
      idHash: debugHash(domId(node)), textHash: debugHash(text), textLength: text.length,
      candidateCount: candidates?.length || 0,
      candidateIndexes: (candidates || []).map(item => records.indexOf(item)).filter(index => index >= 0).slice(0, 12),
      matchedIndex: record ? records.indexOf(record) : -1,
      connected: !!node?.isConnected, display: node ? getComputedStyle(node).display : null,
      top: rect ? Math.round(rect.top) : null, height: rect ? Math.round(rect.height) : null
    };
  }

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.setAttribute('data-cgmap', '');
  const shadow = host.attachShadow({ mode: 'open' });
  const sheet = document.createElement('link');
  sheet.rel = 'stylesheet';
  sheet.href = chrome.runtime.getURL('panel.css');
  shadow.append(sheet);

  function element(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '18');
    svg.setAttribute('height', '18');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.8');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    const paths = {
      map: ['M4 5h5M4 12h8M4 19h5M15 5h5M16 12h4M13 19h7'],
      collapse: ['m9 5 7 7-7 7'],
      search: ['M21 21l-5-5', 'M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0'],
      close: ['m6 6 12 12M6 18 18 6'],
      refresh: ['M20 7v5h-5', 'M4 17v-5h5', 'M6.1 7a7 7 0 0 1 11.6-1.2L20 8', 'M4 16l2.3 2.2A7 7 0 0 0 17.9 17'],
    };
    for (const d of paths[name] || paths.map) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      svg.append(path);
    }
    return svg;
  }

  function button(className, label) {
    const el = element('button', className);
    el.type = 'button';
    el.setAttribute('aria-label', label);
    el.title = label;
    return el;
  }

  const panel = element('section', 'cg-panel');
  panel.setAttribute('aria-label', '对话小地图');
  const header = element('div', 'cg-header');
  const brand = element('div', 'cg-brand');
  brand.append(icon('map'), element('span', '', '对话小地图'), element('small', '', '对话导航'));
  const collapseButton = button('cg-icon-button', '收起小地图（Alt + Shift + M）');
  collapseButton.append(icon('collapse'));
  header.append(brand, collapseButton);

  const controls = element('div', 'cg-controls');
  const tabs = element('div', 'cg-tabs');
  tabs.setAttribute('role', 'group');
  tabs.setAttribute('aria-label', '显示消息范围');
  const allTab = button('cg-tab', '显示全部消息');
  allTab.textContent = '全部消息';
  const userTab = button('cg-tab', '只显示我的提问');
  userTab.textContent = '仅提问';
  tabs.append(allTab, userTab);

  const search = element('label', 'cg-search');
  const searchInput = element('input');
  searchInput.type = 'search';
  searchInput.placeholder = '搜索消息与标题…';
  searchInput.setAttribute('aria-label', '搜索消息与标题');
  searchInput.autocomplete = 'off';
  searchInput.spellcheck = false;
  const clearButton = button('cg-clear', '清空搜索');
  clearButton.append(icon('close'));
  clearButton.hidden = true;
  search.append(icon('search'), searchInput, clearButton);

  const toolbar = element('div', 'cg-toolbar');
  const depthLabel = element('label', 'cg-depth');
  const depthSelect = element('select');
  depthSelect.setAttribute('aria-label', '显示标题深度');
  for (const [value, label] of [['0', '仅消息'], ['1', 'H1'], ['2', 'H1–H2'], ['3', 'H1–H3']]) {
    const option = element('option', '', label);
    option.value = value;
    depthSelect.append(option);
  }
  depthLabel.append(element('span', '', '标题'), depthSelect);
  const followLabel = element('label', 'cg-follow');
  const followInput = element('input');
  followInput.type = 'checkbox';
  followInput.setAttribute('aria-label', '小地图跟随当前阅读位置');
  followLabel.title = '页面滚动时，让当前条目保持在小地图内可见';
  followLabel.append(followInput, element('span', '', '跟随'));
  toolbar.append(depthLabel, followLabel);
  controls.append(tabs, search, toolbar);

  const list = element('nav', 'cg-list');
  list.setAttribute('aria-label', '对话消息与标题');
  const footer = element('div', 'cg-footer');
  const countLabel = element('span', 'cg-count');
  const positionLabel = element('span', 'cg-position', '0%');
  positionLabel.setAttribute('aria-label', '阅读进度');
  const progress = element('div', 'cg-progress');
  progress.setAttribute('aria-hidden', 'true');
  const progressFill = element('span');
  progress.append(progressFill);
  const fontTools = element('div', 'cg-font-tools');
  fontTools.setAttribute('role', 'group');
  fontTools.setAttribute('aria-label', '目录字号');
  const fontSmaller = button('cg-font-btn', '减小字号');
  fontSmaller.textContent = 'A−';
  const fontValue = element('span', 'cg-font-value', '15');
  fontValue.setAttribute('aria-live', 'polite');
  const fontLarger = button('cg-font-btn', '增大字号');
  fontLarger.textContent = 'A+';
  fontTools.append(fontSmaller, fontValue, fontLarger);
  fontSmaller.addEventListener('click', () => updateSettings({ fontSize: settings.fontSize - 1 }));
  fontLarger.addEventListener('click', () => updateSettings({ fontSize: settings.fontSize + 1 }));
  footer.append(countLabel, fontTools, positionLabel, progress);
  const statusBar = element('div', 'cg-load-status');
  const statusText = element('span', 'cg-load-text', '正在读取完整对话…');
  statusText.setAttribute('role', 'status');
  const refreshButton = button('cg-refresh', '重新读取完整对话');
  refreshButton.append(icon('refresh'));
  statusBar.append(statusText, refreshButton);
  const diagnostics = element('section', 'cg-diagnostics');
  diagnostics.hidden = true;
  diagnostics.setAttribute('aria-label', '读取或跳转失败详情');
  const errorSummary = element('div', 'cg-error-summary');
  errorSummary.setAttribute('role', 'status');
  const errorHelp = element('p', 'cg-error-help');
  const errorTools = element('div', 'cg-error-tools');
  const errorCodeLabel = element('code', 'cg-error-code');
  const copyError = button('cg-error-copy', '复制诊断');
  copyError.textContent = '复制诊断';
  const diagnosticOutput = element('textarea', 'cg-diagnostic-output');
  diagnosticOutput.readOnly = true;
  diagnosticOutput.hidden = true;
  diagnosticOutput.setAttribute('aria-label', '可复制诊断');
  errorTools.append(errorCodeLabel, copyError);
  diagnostics.append(errorSummary, errorHelp, errorTools, diagnosticOutput);
  copyError.addEventListener('click', async () => {
    const report = JSON.stringify(diagnosticReport(), null, 2);
    diagnosticOutput.value = report;
    diagnosticOutput.hidden = false;
    try { await navigator.clipboard.writeText(report); copyError.textContent = '已复制'; }
    catch { diagnosticOutput.focus(); diagnosticOutput.select(); copyError.textContent = '按 Ctrl+C 复制'; }
  });
  const detail = element('section', 'cg-detail');
  detail.hidden = true;
  detail.setAttribute('aria-label', '完整消息');
  const detailHeader = element('div', 'cg-detail-header');
  const detailBack = button('cg-detail-back', '返回对话目录');
  detailBack.textContent = '← 返回';
  const detailTitle = element('strong');
  const detailText = element('pre', 'cg-detail-text');
  detailText.tabIndex = 0;
  const detailJump = button('cg-detail-jump', '跳转到网页中的这条消息');
  detailJump.textContent = '跳转到原对话';
  let detailEntry = null;
  detailHeader.append(detailBack, detailTitle);
  detail.append(detailHeader, detailText, detailJump);
  detailBack.addEventListener('click', () => { detail.hidden = true; });
  detailJump.addEventListener('click', () => { if (detailEntry) { detail.hidden = true; jumpTo(detailEntry); } });
  refreshButton.addEventListener('click', () => requestConversation(true));
  list.addEventListener('wheel', () => { manualListUntil = Date.now() + 4000; }, { passive: true });
  list.addEventListener('pointerdown', () => { manualListUntil = Date.now() + 4000; });
  panel.append(header, controls, statusBar, diagnostics, list, footer, detail);

  const launcher = button('cg-launcher', '展开对话小地图（Alt + Shift + M）');
  const launcherCount = element('span', 'cg-launcher-count', '0');
  launcher.append(icon('map'), launcherCount);
  shadow.append(panel, launcher);
  document.documentElement.append(host);

  const colorPreference = window.matchMedia('(prefers-color-scheme: dark)');
  function updateTheme() {
    const root = document.documentElement;
    const declared = root.getAttribute('data-theme') || (document.body && document.body.getAttribute('data-theme'));
    const scheme = window.getComputedStyle(root).colorScheme;
    let dark = colorPreference.matches;
    if (root.classList.contains('dark') || declared === 'dark' || scheme === 'dark') dark = true;
    else if (root.classList.contains('light') || declared === 'light' || scheme === 'light') dark = false;
    const theme = dark ? 'dark' : 'light';
    if (host.getAttribute('data-theme') !== theme) host.setAttribute('data-theme', theme);
  }
  const themeObserver = new MutationObserver(updateTheme);
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });
  if (document.body) themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });
  colorPreference.addEventListener('change', updateTheme);
  updateTheme();

  function sanitizeSettings(value) {
    const candidate = value && typeof value === 'object' ? value : {};
    return {
      open: typeof candidate.open === 'boolean' ? candidate.open : defaults.open,
      scope: candidate.scope === 'user' ? 'user' : 'all',
      depth: [0, 1, 2, 3].includes(Number(candidate.depth)) ? Number(candidate.depth) : defaults.depth,
      follow: typeof candidate.follow === 'boolean' ? candidate.follow : defaults.follow,
      fontSize: Number.isFinite(Number(candidate.fontSize)) && Number(candidate.fontSize) >= 14 && Number(candidate.fontSize) <= 18 ? Math.round(Number(candidate.fontSize)) : defaults.fontSize,
    };
  }

  function saveSettings() {
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      try {
        const result = chrome.storage.local.set({ [SETTINGS_KEY]: { ...settings } });
        if (result && typeof result.catch === 'function') result.catch(() => {});
      } catch (_) { /* The extension may have been reloaded in the background. */ }
    }, 120);
  }

  function applySettings() {
    host.style.setProperty('--cg-font-size', settings.fontSize + 'px');
    fontValue.textContent = String(settings.fontSize);
    fontValue.setAttribute('aria-label', '当前字号 ' + settings.fontSize + ' 像素');
    fontSmaller.disabled = settings.fontSize <= 14;
    fontLarger.disabled = settings.fontSize >= 18;
    panel.hidden = !settings.open;
    launcher.hidden = settings.open;
    launcher.setAttribute('aria-expanded', String(settings.open));
    allTab.classList.toggle('is-active', settings.scope === 'all');
    userTab.classList.toggle('is-active', settings.scope === 'user');
    allTab.setAttribute('aria-pressed', String(settings.scope === 'all'));
    userTab.setAttribute('aria-pressed', String(settings.scope === 'user'));
    depthSelect.value = String(settings.depth);
    followInput.checked = settings.follow;
  }

  function updateSettings(patch) {
    settings = sanitizeSettings({ ...settings, ...patch });
    applySettings();
    saveSettings();
    renderList();
    schedulePosition();
  }

  function toggleOpen() {
    updateSettings({ open: !settings.open });
  }

  collapseButton.addEventListener('click', () => {
    updateSettings({ open: false });
    launcher.focus({ preventScroll: true });
  });
  launcher.addEventListener('click', () => {
    updateSettings({ open: true });
    collapseButton.focus({ preventScroll: true });
  });
  allTab.addEventListener('click', () => updateSettings({ scope: 'all' }));
  userTab.addEventListener('click', () => updateSettings({ scope: 'user' }));
  depthSelect.addEventListener('change', () => updateSettings({ depth: Number(depthSelect.value) }));
  followInput.addEventListener('change', () => updateSettings({ follow: followInput.checked }));
  searchInput.addEventListener('input', () => {
    searchValue = searchInput.value.trim().toLocaleLowerCase();
    clearButton.hidden = !searchInput.value;
    renderList();
    schedulePosition();
  });
  clearButton.addEventListener('click', (event) => {
    event.preventDefault();
    searchInput.value = '';
    searchValue = '';
    clearButton.hidden = true;
    renderList();
    schedulePosition();
    searchInput.focus({ preventScroll: true });
  });
  shadow.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !detail.hidden) { event.preventDefault(); event.stopPropagation(); detail.hidden = true; return; }
    if (event.key === 'Escape' && settings.open) {
      event.preventDefault();
      event.stopPropagation();
      updateSettings({ open: false });
      launcher.focus({ preventScroll: true });
    }
  });

  function onShortcut(event) {
    if (event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey && event.code === 'KeyM') {
      event.preventDefault();
      toggleOpen();
    }
  }
  document.addEventListener('keydown', onShortcut);

  function idFor(node, suffix) {
    if (!nodeIds.has(node)) nodeIds.set(node, ++nodeSequence);
    return `${nodeIds.get(node)}-${suffix}`;
  }

  function textFor(node) {
    // Prefer the rendered content so hidden accessibility markup is not repeated.
    return (node.innerText || node.textContent || '').replace(/\u200B/g, '').trim();
  }

  function contentFor(message) {
    return message.querySelector('.markdown, [data-markdown-text-style="assistant-message"], .whitespace-pre-wrap, [data-message-content], [data-chatgpt-search-message-content]') || message;
  }

  function shortText(value, fallback) {
    const firstLine = value.split(/\n+/).find(line => line.trim()) || fallback;
    const normalized = firstLine.replace(/\s+/g, ' ').trim();
    return normalized.length > 130 ? `${normalized.slice(0, 129)}…` : normalized;
  }

  function findMessages() {
    const main = globalThis.CGMapPage?.conversationRoot?.() || document.querySelector('main') || document.body;
    if (!main) return [];
    const discovered = globalThis.CGMapPage?.messageRows?.(main) || [];
    let legacy = discovered.map(row => ({ node: row.identityNode || row.node, role: row.role }));
    const overlaps = (a, b) => a === b || a.contains(b) || b.contains(a);
    // Full API records also identify messages on layouts with no legacy attributes.
    // Keep all records available to the locator so quoted/repeated text stays ambiguous.
    legacy.sort((a, b) => {
      const order = a.node.compareDocumentPosition(b.node);
      return order & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : order & Node.DOCUMENT_POSITION_PRECEDING ? 1 : 0;
    });
    const matchedRows = matchMountedMessages(legacy);
    locatorDebug = matchedRows.map(row => debugNode(row.node, row.role, row.candidates, row.record));
    const confirmed = matchedRows.filter(row => row.record);
    const claimed = new Set(confirmed.map(row => row.record.id));
    const fallback = [];
    if (globalThis.CGMapLocator) {
      const located = globalThis.CGMapLocator.find(main, records.filter(record => !record.local));
      for (const row of located) {
        // Nested bodies claiming different messages do not prove separate identities.
        if (located.some(other => other !== row && other.recordId !== row.recordId && overlaps(other.node, row.node))) continue;
        if (claimed.has(row.recordId) || confirmed.some(old => overlaps(old.node, row.node))) continue;
        if (legacy.some(old => overlaps(old.node, row.node) && old.role !== row.role)) continue;
        // A confirmed body can replace an unrecognized wrapper, never coexist with it.
        legacy = legacy.filter(old => !overlaps(old.node, row.node));
        fallback.push({ ...row, source: 'content' });
        claimed.add(row.recordId);
        const record = records.find(item => item.id === row.recordId && item.role === row.role);
        locatorDebug.push(debugNode(row.node, row.role, record ? [record] : [], record));
      }
    }
    const result = [...legacy, ...fallback].sort((a, b) => {
      const order = a.node.compareDocumentPosition(b.node);
      return order & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : order & Node.DOCUMENT_POSITION_PRECEDING ? 1 : 0;
    });
    locatorState = { legacy: legacy.length, content: fallback.length, matched: locatorState.matched };
    return result;
  }

  function currentConversationId() {
    const parts = location.pathname.split('/').filter(Boolean);
    const index = parts.lastIndexOf('c');
    // Keep the UI aware of a `/c/<id>` segment even when the bridge does not
    // yet support an unfamiliar prefix; that produces an explicit route
    // diagnostic instead of silently showing a new-chat state.
    if (index < 0 || index !== parts.length - 2) return '';
    try {
      const id = decodeURIComponent(parts[index + 1]);
      return /^[a-zA-Z0-9_:-]{1,256}$/.test(id) ? id : '';
    } catch { return ''; }
  }

  function domId(node) {
    const readSearchId = element => {
      const values = [];
      for (const current of [element, ...element.querySelectorAll('[data-chatgpt-search-message-ids]')]) {
        const raw = current.getAttribute?.('data-chatgpt-search-message-ids') || '';
        if (!raw) continue;
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed) && parsed.length === 1 && typeof parsed[0] === 'string') values.push(parsed[0]);
          else if (typeof parsed === 'string') values.push(parsed);
        } catch {
          const tokens = raw.split(/[\s,]+/).filter(Boolean);
          if (tokens.length === 1) values.push(tokens[0]);
        }
      }
      return new Set(values.filter(value => /^[a-zA-Z0-9_:-]{2,256}$/.test(value))).size === 1 ? values.find(value => /^[a-zA-Z0-9_:-]{2,256}$/.test(value)) || '' : '';
    };
    const direct = node.getAttribute('data-message-id') || node.getAttribute('data-message-uuid') || readSearchId(node);
    if (direct) return direct;
    const innerIds = new Set(Array.from(node.querySelectorAll('[data-message-id], [data-message-uuid]')).map(item => item.getAttribute('data-message-id') || item.getAttribute('data-message-uuid')).filter(Boolean));
    const searchId = readSearchId(node);
    if (searchId) innerIds.add(searchId);
    if (innerIds.size === 1) return Array.from(innerIds)[0];
    const ancestor = node.parentElement?.closest('[data-message-id], [data-message-uuid], [data-chatgpt-search-message-ids]');
    if (!ancestor) return '';
    const peers = ancestor.querySelectorAll('[data-message-author-role="user"], [data-message-author-role="assistant"], [data-chatgpt-search-unit-key$=":user"], [data-chatgpt-search-unit-key$=":assistant"], section[data-turn="user"], section[data-turn="assistant"], article[data-turn="user"], article[data-turn="assistant"]');
    // A pair wrapper may carry the answer's ID. Never borrow it for its question.
    if (Array.from(peers).some(peer => peer !== node && !node.contains(peer))) return '';
    return ancestor.getAttribute('data-message-id') || ancestor.getAttribute('data-message-uuid') || readSearchId(ancestor) || '';
  }

  function normalized(text) {
    return String(text || '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[#*_\x60~>]/g, '').replace(/\s+/g, '').toLocaleLowerCase();
  }

  function fingerprint(node) {
    return domId(node) + ':' + textFor(contentFor(node));
  }

  function activeMessages() {
    return findMessages().filter(({ node }) => !ignoredNodes.has(node) || ignoredNodes.get(node) !== fingerprint(node));
  }

  function messageTextKey(text, role) {
    // Code symbols and letter case distinguish real questions; preserve them.
    return role === 'user'
      ? String(text || '').replace(/\u200B/g, '').replace(/\s+/g, ' ').trim()
      : normalized(text);
  }

  function recordCandidates(node, role) {
    const id = domId(node);
    if (id) {
      const byId = records.filter(record => record.role === role && (record.id === id || record.nodeId === id));
      // ChatGPT can expose a node/turn id in the DOM while the conversation
      // response exposes the message id. If the identity is not shared, use
      // the complete rendered body as the second, exact identity check.
      if (byId.length) return byId;
    }
    const text = messageTextKey(textFor(contentFor(node)), role);
    if (!text) return [];
    const sameRole = records.filter(record => record.role === role);
    const exact = sameRole.filter(record => messageTextKey(record.text, role) === text);
    if (exact.length) return exact;
    // A rendered answer can be shortened by citation/tool decorations or a
    // collapsed body even after generation finished. Require a substantial,
    // unique prefix overlap before accepting that answer as an anchor.
    if (role !== 'assistant' || text.length < 24) return [];
    return sameRole.filter(record => {
      const candidate = messageTextKey(record.text, role);
      if (candidate.length < 24 || (!candidate.startsWith(text) && !text.startsWith(candidate))) return false;
      if (record.status === 'in_progress' || record.local) return true;
      const overlap = Math.min(candidate.length, text.length) / Math.max(candidate.length, text.length);
      return text.length >= 80 && overlap >= 0.55;
    });
  }

  function matchMountedMessages(messages) {
    const rows = messages.map(item => ({
      ...item,
      candidates: item.recordId !== undefined
        ? records.filter(record => record.id === item.recordId && record.role === item.role)
        : recordCandidates(item.node, item.role),
      record: null
    }));
    const claimed = new Set();
    const counts = new Map();
    for (const row of rows) if (row.candidates.length === 1) counts.set(row.candidates[0], (counts.get(row.candidates[0]) || 0) + 1);
    for (const row of rows) {
      if (row.candidates.length === 1 && counts.get(row.candidates[0]) === 1) {
        row.record = row.candidates[0]; claimed.add(row.record);
      }
    }
    const indices = new Map(records.map((record, index) => [record, index]));
    // The rollout exposes explicit user/assistant markers even when its DOM
    // message id is not the API message id. A directly matched user marker
    // followed by an assistant marker is strong branch-order evidence: bind
    // the next visible assistant record instead of dropping every answer.
    for (let pass = 0; pass < 2; pass++) {
      for (let index = 0; index < rows.length; index++) {
        const row = rows[index];
        if (row.record || row.role !== 'assistant') continue;
        let previous = null;
        for (let prior = index - 1; prior >= 0; prior--) {
          if (rows[prior].record) { previous = rows[prior]; break; }
        }
        let next = null;
        if (previous) {
          const previousIndex = indices.get(previous.record);
          const candidate = records[previousIndex + 1];
          if (candidate?.role === 'assistant' && !claimed.has(candidate)) next = candidate;
        }
        if (!next) {
          for (let after = index + 1; after < rows.length; after++) {
            if (!rows[after].record) continue;
            const afterIndex = indices.get(rows[after].record);
            const candidate = records[afterIndex - 1];
            if (candidate?.role === 'assistant' && !claimed.has(candidate)) next = candidate;
            break;
          }
        }
        if (next) { row.record = next; claimed.add(next); }
      }
    }
    // DOM turn numbers can count pairs or recycled slots. Only confirmed message
    // identities on either side may narrow an otherwise ambiguous text match.
    for (let pass = 0; pass < 2; pass++) {
      for (let index = 0; index < rows.length; index++) {
        const row = rows[index];
        if (row.record || !row.candidates.length) continue;
        let before = -1, after = records.length;
        for (let n = index - 1; n >= 0; n--) if (rows[n].record) { before = indices.get(rows[n].record); break; }
        for (let n = index + 1; n < rows.length; n++) if (rows[n].record) { after = indices.get(rows[n].record); break; }
        if (before >= after) continue;
        const choices = row.candidates.filter(record => !claimed.has(record) && indices.get(record) > before && indices.get(record) < after);
        // Two DOM nodes competing for one candidate are not independent evidence.
        if (choices.length === 1 && !rows.some(other => other !== row && !other.record && other.candidates.length === 1 && other.candidates[0] === choices[0])) {
          row.record = choices[0]; claimed.add(row.record);
        }
      }
    }
    return rows;
  }

  function rebuildEntries() {
    let users = 0;
    let assistants = 0;
    entries = [];
    records.forEach((record, order) => {
      record.order = order;
      record.number = record.role === 'user' ? ++users : ++assistants;
      const base = { record, role: record.role, number: record.number, target: record.target || null };
      entries.push({ ...base, id: record.id + ':message', level: 0, label: shortText(record.text, record.role === 'user' ? '图片或附件提问' : '正在生成回答…'), searchText: record.text.toLocaleLowerCase() });
      const seen = new Map();
      for (const h of record.headings || []) {
        const key = h.level + ':' + h.text;
        const index = seen.get(key) || 0;
        seen.set(key, index + 1);
        entries.push({ ...base, id: record.id + ':heading:' + (h.id || key + ':' + index), level: h.level, heading: { ...h, index }, label: h.text, searchText: h.text.toLocaleLowerCase() });
      }
    });
    if (!detail.hidden && detailEntry) {
      const latest = entries.find(entry => entry.id === detailEntry.id);
      if (latest) { detailEntry = latest; if (detailText.textContent !== latest.record.text) detailText.textContent = latest.record.text; }
      else { detail.hidden = true; detailEntry = null; detailText.textContent = ''; }
    }
    messageCount = records.length;
    launcherCount.textContent = String(messageCount);
    const signature = entries.map(entry => entry.id + ':' + entry.number + ':' + entry.label).join('|');
    if (signature !== lastSignature || searchValue) { lastSignature = signature; renderList(); }
    updateStatus();
    schedulePosition();
  }

  function updateStatus() {
    statusBar.dataset.state = loadState;
    diagnostics.hidden = loadState !== 'error' && !navigationError;
    if (!diagnostics.hidden) {
      errorSummary.textContent = loadError || '完整对话未能读取。';
      errorCodeLabel.textContent = [errorCode.toUpperCase(), errorHttpStatus ? 'HTTP ' + errorHttpStatus : ''].filter(Boolean).join(' · ');
      errorHelp.textContent = errorCode === 'bridge_missing'
        ? '请在 edge://extensions 重新加载本扩展，再刷新整个 ChatGPT 网页。'
        : ['unsupported_route', 'route_mismatch'].includes(errorCode)
          ? '当前页面地址未被读取模块接受。可复制诊断中的脱敏地址结构协助排查。'
        : errorCode === 'request_unacknowledged'
          ? '读取模块已连接，但没有确认这次请求；请重新加载扩展、刷新整个网页后再试。'
        : errorHttpStatus === 404 && errorStage === 'conversation-authenticated'
          ? '请确认网页能正常打开这条对话，并复制下方诊断。可能涉及当前账号授权、会话状态或接口变化。'
        : errorHttpStatus === 429
          ? '请求过于频繁，请稍后再试，避免连续点击刷新。'
        : errorStage === 'parse'
          ? '网页数据格式暂不兼容。可复制诊断协助修复，当前目录仍可能不完整。'
          : '请刷新整个 ChatGPT 网页一次，以尝试复用网页成功加载的会话。仍失败时可复制下方诊断。';
    }
    if (navigationError && loadState !== 'error') {
      const messages = {
        'page-structure-not-recognized': '已读取完整消息，但暂时无法将消息对应到当前网页。',
        'target-not-rendered': '已识别部分网页消息，但没有找到所选消息的准确位置。',
        'target-unmounted-during-jump': '定位过程中网页移除了目标消息，请稍后重试。',
        'heading-not-found': '已找到这条消息，但尚未找到对应标题。',
        'position-not-stable': '已找到目标，但网页持续调整滚动位置，定位已停止。'
      };
      errorSummary.textContent = messages[navigationError.reason] || '本次消息定位没有完成。';
      errorCodeLabel.textContent = 'NAVIGATION · ' + navigationError.reason.toUpperCase();
      errorHelp.textContent = '可先点击全文阅读；如需反馈，点击复制诊断，其中包含本次跳转结果。';
    }
    if (loadState === 'loading') statusText.textContent = '正在读取完整对话…';
    else if (complete) statusText.textContent = '完整分支 · ' + messageCount + ' 条消息';
    else if (loadState === 'error') statusText.textContent = '完整读取失败 · 已捕获 ' + messageCount + ' 条';
    else statusText.textContent = '当前页已捕获 ' + messageCount + ' 条 · 等待对话保存';
    statusText.title = loadError || (complete ? '已读取当前选中对话分支。网页移除离屏消息时，目录仍会保留。' : '当前索引尚不完整，点击右侧按钮重新读取。');
    refreshButton.disabled = !!pendingRequest;
  }

  function routeShape() {
    const parts = location.pathname.split('/').filter(Boolean);
    const shape = parts.slice(0, 10).map((part, index) => {
      if ((index === 0 && part === 'g') || (index === parts.length - 2 && part === 'c') || (index === 2 && part === 'project')) return part;
      return ':segment';
    });
    return '/' + shape.join('/') + (parts.length > 10 ? '/:more' : '');
  }

  function diagnosticReport() {
    const mounted = bindMounted(false);
    const main = globalThis.CGMapPage?.conversationRoot?.() || document.querySelector('main') || document.body;
    return {
      extensionVersion, bridgeVersion: bridgeVersion || null, bridgeReady,
      bridgeRouteSupported, requestAcknowledged, requestStage: requestStage || null, routeShape: routeShape(),
      code: errorCode || null, stage: errorStage || null, httpStatus: errorHttpStatus,
      host: location.hostname, routeType: currentConversationId() ? 'conversation' : 'new-chat',
      projectOrCustomGPT: /^\/g\//.test(location.pathname),
      indexedMessages: messageCount, visibleMessages: mounted.length,
      documentState: document.readyState, hasMain: !!main,
      mainTextCharacters: (main?.textContent || '').length,
      embeddedFrames: main?.querySelectorAll('iframe').length || 0,
      openShadowRoots: main ? Array.from(main.querySelectorAll('*')).filter(node => node.shadowRoot).length : 0,
      roleElements: document.querySelectorAll('[data-message-author-role="user"], [data-message-author-role="assistant"], [data-chatgpt-search-unit-key$=":user"], [data-chatgpt-search-unit-key$=":assistant"], section[data-turn="user"], section[data-turn="assistant"], article[data-turn="user"], article[data-turn="assistant"]').length,
      locator: { ...locatorState, ...(globalThis.CGMapLocator?.stats() || {}) },
      locatorDebug: locatorDebug.slice(0, 24),
      pageRegion: globalThis.CGMapPage?.stats?.() || null,
      complete, lastSource: lastSource || null, navigation: navigationError
    };
  }

  function setReadError(error) {
    complete = false;
    loadState = 'error';
    loadError = typeof error.message === 'string' ? error.message.slice(0, 300) : '完整对话读取失败。';
    errorCode = String(error.code || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60);
    errorStage = String(error.stage || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60);
    errorHttpStatus = Number.isInteger(error.httpStatus) ? error.httpStatus : null;
    if ((errorStage === 'conversation-authenticated' && errorHttpStatus === 404) || errorStage === 'route') {
      clearTimeout(refreshTimer); refreshTimer = 0;
    }
    diagnosticOutput.hidden = true; diagnosticOutput.value = '';
    copyError.textContent = '复制诊断';
    updateStatus();
  }

  function pingBridge() {
    if (bridgePingId) return;
    bridgePingId = 'ping-' + crypto.randomUUID();
    const id = bridgePingId;
    window.postMessage({ source: 'cgmap-extension', type: 'bridge-ping', requestId: id }, location.origin);
    bridgeTimer = window.setTimeout(() => {
      if (bridgePingId !== id) return;
      bridgePingId = ''; bridgeReady = false;
      if (!conversationId) return;
      cancelRequest(); refreshAfterPending = false;
      setReadError({code: 'bridge_missing', stage: 'bridge', message: '网页读取模块未连接，扩展可能没有完整更新或网页尚未刷新。'});
    }, 2500);
  }

  function cancelRequest() {
    if (pendingRequest) window.postMessage({ source: 'cgmap-extension', type: 'conversation-cancel', ...pendingRequest }, location.origin);
    pendingRequest = null;
    pendingAddedIds.clear();
    clearTimeout(requestTimer);
  }

  function checkRoute() {
    const next = currentConversationId();
    if (next === conversationId && location.pathname === lastLocation) return false;
    const previousId = conversationId;
    conversationId = next;
    lastLocation = location.pathname;
    if (next === previousId) {
      // The page bridge cancels jobs on any pathname change, including aliases
      // for the same conversation. Reissue without discarding this tab's index.
      routeGeneration++; jumpController?.abort(); navigationError = null;
      cancelRequest(); clearTimeout(refreshTimer); refreshTimer = 0;
      refreshAfterPending = false; bridgeRouteSupported = null;
      if (next) requestConversation();
      else { loadState = 'local'; requestAcknowledged = false; requestStage = ''; }
      return false;
    }
    ignoredNodes = new Map(lastMountedFingerprints);
    lastMountedFingerprints.clear();
    if (!previousId) ignoredNodes.clear();
    routeGeneration++;
    jumpController?.abort();
    cancelRequest();
    clearTimeout(refreshTimer); refreshTimer = 0;
    refreshAfterPending = false;
    records = []; entries = []; messageCount = 0;
    observedTexts.clear(); mountedTargets = []; locatorState = { legacy: 0, content: 0, matched: 0 }; locatorDebug = []; navigationError = null; bridgeRouteSupported = null; requestAcknowledged = false; requestStage = ''; lastSource = ''; errorCode = ''; errorStage = ''; errorHttpStatus = null; diagnosticOutput.hidden = true;
    complete = false; loadState = next ? 'loading' : 'local'; loadError = '';
    activeId = ''; lastFollowId = ''; lastSignature = '';
    detail.hidden = true; detailEntry = null; detailText.textContent = '';
    searchValue = ''; searchInput.value = ''; clearButton.hidden = true;
    list.scrollTop = 0;
    renderList();
    if (next) requestConversation();
    return true;
  }

  function requestConversation(force = false) {
    if (isDestroyed || !conversationId) { updateStatus(); return; }
    if (pendingRequest) { if (!force) return; cancelRequest(); }
    clearTimeout(refreshTimer); refreshTimer = 0;
    loadState = 'loading'; loadError = ''; errorCode = ''; errorStage = ''; errorHttpStatus = null;
    if (!bridgeReady) pingBridge();
    const requestId = crypto.randomUUID();
    requestAcknowledged = false; requestStage = '';
    refreshAfterPending = false; pendingAddedIds.clear();
    pendingRequest = { conversationId, requestId };
    lastRequestAt = Date.now();
    window.postMessage({ source: 'cgmap-extension', type: 'conversation-request', fresh: force || records.length > 0, ...pendingRequest }, location.origin);
    requestTimer = window.setTimeout(() => {
      if (pendingRequest?.requestId !== requestId) return;
      const timeout = !bridgeReady
        ? {code: 'bridge_missing', stage: 'bridge', message: '网页读取模块未连接，请重新加载扩展并刷新整个网页。'}
        : !requestAcknowledged
          ? {code: 'request_unacknowledged', stage: 'dispatch', message: '读取模块已连接，但未确认这次会话请求。'}
          : {code: 'timeout', stage: requestStage || 'accepted', message: '完整会话读取未在规定时间内完成。'};
      cancelRequest(); refreshAfterPending = false; setReadError(timeout);
    }, 28000);
    updateStatus();
  }

  function scheduleRefresh(addedId) {
    if (!conversationId) return;
    // An authenticated 404 has exhausted this route's automatic fallback.
    // DOM hydration cannot fix it. Explicit refresh and native page recovery remain available.
    if (loadState === 'error' && ((errorStage === 'conversation-authenticated' && errorHttpStatus === 404) || errorStage === 'route')) return;
    if (pendingRequest) {
      // First observing a mounted message does not mean a full response is stale.
      // Only retry if the returned branch lacks it, or observed text actually changed.
      if (addedId !== undefined) pendingAddedIds.add(addedId);
      else refreshAfterPending = true;
      return;
    }
    if (refreshTimer) return;
    // Refresh only on newly observed messages/content, not normal virtual scrolling.
    refreshTimer = window.setTimeout(() => { refreshTimer = 0; requestConversation(); }, Math.max(1600, 5000 - (Date.now() - lastRequestAt)));
  }

  function applyConversationData(data, changedWhilePending, source, addedIds = []) {
    try {
      const result = globalThis.CGMapModel.parseConversation(data);
      const returnedIds = new Set(result.messages.flatMap(record => [record.id, record.nodeId]));
      const textCounts = new Map();
      const keyOf = item => item.role + ':' + messageTextKey(item.text, item.role);
      for (const message of result.messages) { const key = keyOf(message); textCounts.set(key, (textCounts.get(key) || 0) + 1); }
      const missingObservation = addedIds.some(observation => {
        if (typeof observation === 'string') return !returnedIds.has(observation);
        const key = keyOf(observation), count = textCounts.get(key) || 0;
        if (!count) return true;
        textCounts.set(key, count - 1); return false;
      });
      changedWhilePending ||= missingObservation;
      // A successful native response supersedes an older queued refresh.
      clearTimeout(refreshTimer); refreshTimer = 0;
      records = result.messages.map(record => ({ ...record, target: null }));
      complete = !changedWhilePending; loadState = changedWhilePending ? 'loading' : 'full'; loadError = '';
      errorCode = ''; errorStage = ''; errorHttpStatus = null;
      lastSource = ['page-fetch','page-cache','cookie','session','direct'].includes(source) ? source : 'direct';
      bindMounted(false);
      rebuildEntries();
      if (changedWhilePending || records.some(record => record.status === 'in_progress')) scheduleRefresh();
    } catch (error) {
      setReadError({code: 'conversation_format', stage: 'parse', message: error.message || '会话数据格式暂不支持。'});
    }
  }

  function onConversationResponse(event) {
    if (event.source !== window || event.origin !== location.origin) return;
    const value = event.data;
    if (!value || value.source !== 'cgmap-page') return;
    if (value.type === 'bridge-ready') {
      if (value.requestId !== bridgePingId) return;
      clearTimeout(bridgeTimer); bridgePingId = ''; bridgeReady = true;
      bridgeVersion = typeof value.version === 'string' ? value.version.slice(0, 20) : 'unknown';
      if (typeof value.routeSupported === 'boolean') bridgeRouteSupported = value.routeSupported;
      return;
    }
    if (value.type === 'conversation-progress') {
      if (!pendingRequest || value.requestId !== pendingRequest.requestId || value.conversationId !== conversationId || currentConversationId() !== conversationId) return;
      if (!['accepted','conversation-cookie','session','session-json','conversation-authenticated','conversation-json','conversation-pages','page-cache'].includes(value.stage)) return;
      requestAcknowledged = true; requestStage = value.stage; bridgeRouteSupported = true;
      return;
    }
    if (value.type === 'conversation-update') {
      if (!conversationId || value.conversationId !== conversationId || currentConversationId() !== conversationId) return;
      const changedWhilePending = refreshAfterPending;
      const addedIds = Array.from(pendingAddedIds);
      cancelRequest(); refreshAfterPending = false;
      applyConversationData(value.data, changedWhilePending, value.via || 'page-fetch', addedIds);
      return;
    }
    if (value.type !== 'conversation-response' || !pendingRequest) return;
    if (value.requestId !== pendingRequest.requestId || value.conversationId !== conversationId || currentConversationId() !== conversationId) return;
    clearTimeout(requestTimer); pendingRequest = null;
    const changedWhilePending = refreshAfterPending;
    const addedIds = Array.from(pendingAddedIds); pendingAddedIds.clear();
    refreshAfterPending = false;
    requestAcknowledged = true;
    if (value.error) {
      if (value.error.code === 'unsupported_route') bridgeRouteSupported = false;
      else if (value.error.code === 'route_mismatch') bridgeRouteSupported = true;
      setReadError(value.error); return;
    }
    applyConversationData(value.data, changedWhilePending, value.via, addedIds);
  }
  window.addEventListener('message', onConversationResponse);

  function bindMounted(merge = true) {
    const mounted = [];
    const messages = matchMountedMessages(activeMessages());
    let changed = false;
    for (const row of messages) {
      const { node, role } = row;
      const content = contentFor(node);
      const text = textFor(content);
      let record = row.record;
      if (!record && merge && row.source !== 'content' && row.candidates.length === 0) {
        const id = domId(node) || 'local:' + (++nodeSequence) + ':' + role;
        record = records.find(item => item.id === id && item.role === role);
        if (!record) {
          record = { id, nodeId: id, role, text, headings: [], local: true };
          records.push(record); changed = true;
          if (complete) { complete = false; loadState = 'loading'; }
          scheduleRefresh(domId(node) || { role, text });
        }
      }
      if (!record) continue;
      record.target = node; recordByDom.set(node, record);
      const domText = normalized(text);
      const previouslyObserved = observedTexts.get(record.id);
      observedTexts.set(record.id, domText);
      if (row.source !== 'content' && !record.local && previouslyObserved !== undefined && previouslyObserved !== domText) scheduleRefresh();
      if (record.local) {
        if (record.text !== text) { record.text = text; changed = true; scheduleRefresh(); }
        record.headings = Array.from(content.querySelectorAll('h1,h2,h3')).filter(h => !h.closest('pre,code,[hidden],[aria-hidden="true"]')).map((h, i) => ({ id: 'dom-h-' + i, text: textFor(h), level: Number(h.tagName.slice(1)) }));
      }
      mounted.push({ record, target: node });
    }
    if (changed && !complete) {
      // Stable DOM turn IDs order the fallback cache; unlike v1, unmounted nodes stay indexed.
      if (records.every(record => record.local)) records.sort((a,b) => {
        const x = a.target?.closest('[data-testid^="conversation-turn-"]')?.getAttribute('data-testid')?.match(/(\d+)$/)?.[1];
        const y = b.target?.closest('[data-testid^="conversation-turn-"]')?.getAttribute('data-testid')?.match(/(\d+)$/)?.[1];
        return x !== undefined && y !== undefined ? Number(x) - Number(y) : 0;
      });
    }
    mountedTargets = mounted;
    locatorState.matched = mounted.length;
    return mounted;
  }

  function scan() {
    scanTimer = 0;
    if (isDestroyed) return;
    if (!host.isConnected) document.documentElement.append(host);
    checkRoute();
    const mounted = bindMounted();
    lastMountedFingerprints = new Map(activeMessages().map(({ node }) => [node, fingerprint(node)]));
    scrollContainer = findScrollContainer(mounted[0]?.target);
    rebuildEntries();
  }

  function scheduleScan() {
    // Stream updates are batched, and the shadow tree is not observed.
    if (!scanTimer) scanTimer = window.setTimeout(scan, 220);
  }

  function visibleEntries() {
    return entries.filter(entry => (settings.scope === 'all' || entry.role === 'user') && entry.level <= settings.depth && (!searchValue || entry.searchText.includes(searchValue)));
  }

  function renderList() {
    const visible = visibleEntries();
    const previousScroll = list.scrollTop;
    const focusedId = shadow.activeElement && shadow.activeElement.dataset && shadow.activeElement.dataset.entryId;
    const fragment = document.createDocumentFragment();
    for (const entry of visible) {
      const item = button('cg-item', `${entry.role === 'user' ? '提问' : '回答'} ${entry.number}${entry.level ? `，${entry.level} 级标题` : ''}：${entry.label}`);
      item.dataset.entryId = entry.id;
      item.dataset.role = entry.role;
      item.dataset.level = String(entry.level);
      item.title = entry.label;
      const badge = element('span', 'cg-item-index', entry.level ? `H${entry.level}` : `${entry.role === 'user' ? '问' : '答'} ${entry.number}`);
      const label = element('span', 'cg-item-text', entry.label);
      item.append(badge, label);
      if (entry.id === activeId) {
        item.classList.add('is-active');
        item.setAttribute('aria-current', 'location');
      }
      item.addEventListener('click', () => jumpTo(entries.find(current => current.id === entry.id) || entry));
      const row = element('div', 'cg-row');
      row.append(item);
      if (!entry.level) {
        const view = button('cg-view', '查看' + (entry.role === 'user' ? '提问' : '回答') + ' ' + entry.number + ' 完整内容');
        view.textContent = '全文';
        view.addEventListener('click', () => showDetail(entries.find(current => current.id === entry.id) || entry));
        row.append(view);
      }
      fragment.append(row);
    }
    if (!visible.length) {
      const empty = element('div', 'cg-empty');
      empty.append(element('strong', '', searchValue ? '没有找到匹配内容' : '对话从这里开始'), element('span', '', searchValue ? '试试其他关键词，或切换消息范围。' : '发送第一条消息后，小地图会自动显示提问与回答。'));
      fragment.append(empty);
    }
    list.replaceChildren(fragment);
    list.scrollTop = previousScroll;
    if (focusedId) {
      const item = Array.from(list.querySelectorAll('.cg-item')).find(child => child.dataset.entryId === focusedId);
      if (item) item.focus({ preventScroll: true });
    }
    const count = settings.scope === 'user' ? entries.filter(entry => entry.role === 'user' && entry.level === 0).length : messageCount;
    countLabel.textContent = searchValue ? `${visible.length} 个匹配 · ${count} 条消息` : `${count} 条${settings.scope === 'user' ? '提问' : '消息'} · ${visible.length} 个节点`;
  }

  function showDetail(entry) {
    detailEntry = entry;
    detailTitle.textContent = (entry.role === 'user' ? '提问 ' : '回答 ') + entry.number;
    detailText.textContent = entry.record.text;
    detailText.scrollTop = 0;
    detail.hidden = false;
    detailText.focus({ preventScroll: true });
  }

  function findScrollContainer(target, mounted = mountedTargets) {
    if (typeof globalThis.CGMapNavigation.findScrollContainer === 'function') {
      return globalThis.CGMapNavigation.findScrollContainer(target, mounted);
    }
    let ancestor = target && target.parentElement;
    while (ancestor && ancestor !== document.body && ancestor !== document.documentElement) {
      const style = window.getComputedStyle(ancestor);
      if (/(auto|scroll|overlay)/.test(style.overflowY) && ancestor.scrollHeight > ancestor.clientHeight + 2) return ancestor;
      ancestor = ancestor.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  function viewportFor(container) {
    if (!container || container === document.documentElement || container === document.body || container === document.scrollingElement) {
      return { top: 0, height: window.innerHeight };
    }
    const rect = container.getBoundingClientRect();
    return { top: Math.max(0, rect.top), height: Math.min(window.innerHeight, rect.bottom) - Math.max(0, rect.top) };
  }

  async function jumpTo(entry) {
    jumpController?.abort();
    const controller = new AbortController();
    jumpController = controller;
    const generation = routeGeneration;
    navigationError = null; diagnosticOutput.hidden = true; diagnosticOutput.value = ''; copyError.textContent = '复制诊断';
    updateStatus(); setActive(entry.id);
    statusText.textContent = '正在定位消息…';
    const result = await globalThis.CGMapNavigation.jump({
      record: entry.record, heading: entry.heading, records,
      getMounted: () => bindMounted(false), findScrollContainer, viewportFor,
      signal: controller.signal,
      onProgress: info => { if (jumpController === controller) statusText.textContent = info.message || '正在加载目标位置…'; }
    });
    if (generation !== routeGeneration || jumpController !== controller) return;
    jumpController = null;
    if (controller.signal.aborted) { updateStatus(); return; }
    if (!result.ok) {
      navigationError = {reason: String(result.reason || 'navigation-error').replace(/[^a-z-]/g, '').slice(0, 60), role: entry.role, number: entry.number, headingLevel: entry.level || 0, debug: result.debug || null};
      updateStatus();
      statusText.textContent = '网页暂未定位成功，可点击“全文”查看';
      statusText.title = navigationError.reason;
    } else {
      updateStatus(); setActive(entry.id); schedulePosition();
    }
  }

  function cancelJumpOnInput(event) {
    if (event.composedPath().includes(host)) return;
    if (event.type === 'keydown') {
      if (!['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes(event.key)) return;
      if (event.target?.closest('input,textarea,[contenteditable="true"]')) return;
    }
    jumpController?.abort();
  }
  document.addEventListener('keydown', cancelJumpOnInput, { capture: true });
  document.addEventListener('wheel', cancelJumpOnInput, { passive: true, capture: true });
  document.addEventListener('touchstart', cancelJumpOnInput, { passive: true, capture: true });
  document.addEventListener('pointerdown', cancelJumpOnInput, { passive: true, capture: true });

  function setActive(id) {
    activeId = id;
    let activeItem = null;
    for (const item of list.querySelectorAll('.cg-item')) {
      if (!item.dataset.entryId) continue;
      const active = item.dataset.entryId === id;
      item.classList.toggle('is-active', active);
      if (active) {
        item.setAttribute('aria-current', 'location');
        activeItem = item;
      } else item.removeAttribute('aria-current');
    }
    if (activeItem && settings.follow && settings.open && !jumpController && Date.now() > manualListUntil && lastFollowId !== id) {
      const itemTop = activeItem.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
      const itemBottom = itemTop + activeItem.getBoundingClientRect().height;
      if (itemTop < list.scrollTop) list.scrollTop = itemTop;
      else if (itemBottom > list.scrollTop + list.clientHeight) list.scrollTop = itemBottom - list.clientHeight;
      lastFollowId = id;
    }
  }

  function updatePosition() {
    positionFrame = 0;
    if (isDestroyed) return;
    const visible = visibleEntries();
    const container = scrollContainer || document.scrollingElement || document.documentElement;
    const viewport = viewportFor(container);
    const readingLine = viewport.top + Math.min(120, Math.max(64, viewport.height * 0.18));
    let current = null;
    const mounted = bindMounted(false);
    const targets = new Map(mounted.map(item => [item.record.id, item.target]));
    for (const entry of visible) {
      let target = targets.get(entry.record.id);
      if (!target?.isConnected) continue;
      if (entry.heading) {
        const headings = Array.from(target.querySelectorAll('h1,h2,h3')).filter(h => Number(h.tagName.slice(1)) === entry.level && normalized(h.textContent) === normalized(entry.heading.text));
        target = headings[entry.heading.index || 0];
        if (!target) continue;
      }
      if (!current || target.getBoundingClientRect().top <= readingLine) current = entry;
      else break;
    }
    // At the bottom, reveal the final outline node even when it is too short to reach the reading line.
    const extent = Math.max(0, container.scrollHeight - container.clientHeight);
    const ratio = extent > 0 ? Math.min(1, Math.max(0, container.scrollTop / extent)) : 0;
    if (extent > 0 && container.scrollTop >= extent - 3 && visible.length) current = visible[visible.length - 1];
    if (!jumpController) setActive(current ? current.id : activeId);
    const percentage = messageCount ? Math.round(ratio * 100) : 0;
    positionLabel.textContent = `${percentage}%`;
    progressFill.style.width = `${percentage}%`;
  }

  function schedulePosition() {
    if (!positionFrame) positionFrame = window.requestAnimationFrame(updatePosition);
  }

  function onScroll(event) {
    if (event.composedPath && event.composedPath().includes(host)) return;
    schedulePosition();
  }
  document.addEventListener('scroll', onScroll, { capture: true, passive: true });
  window.addEventListener('resize', schedulePosition, { passive: true });
  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['data-message-author-role', 'data-message-id', 'data-message-uuid', 'data-chatgpt-search-unit-key', 'data-chatgpt-search-message-ids', 'data-markdown-text-style', 'data-turn', 'data-testid', 'hidden', 'aria-hidden'] });
  // Route changes can happen without a relevant DOM mutation.
  const routeTimer = window.setInterval(() => {
    if (location.pathname !== lastLocation) scheduleScan();
  }, 1000);

  function onStorage(changes, area) {
    if (area !== 'local' || !changes[SETTINGS_KEY]) return;
    settings = sanitizeSettings(changes[SETTINGS_KEY].newValue);
    applySettings();
    renderList();
    schedulePosition();
  }

  function onMessage(message, _sender, sendResponse) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'CGMAP_TOGGLE') {
      toggleOpen();
      sendResponse({ open: settings.open, count: messageCount, complete, loading: !!pendingRequest });
    } else if (message.type === 'CGMAP_STATUS') {
      sendResponse({ open: settings.open, count: messageCount, complete, loading: !!pendingRequest });
    }
  }

  try {
    chrome.runtime.onMessage.addListener(onMessage);
    chrome.storage.onChanged.addListener(onStorage);
    chrome.storage.local.get(SETTINGS_KEY, result => {
      if (chrome.runtime.lastError || isDestroyed) return;
      settings = sanitizeSettings(result && result[SETTINGS_KEY]);
      applySettings();
      renderList();
      schedulePosition();
    });
  } catch (_) { /* Local UI continues to work if the extension context expires. */ }

  window.addEventListener('pagehide', event => {
    if (event.persisted) return;
    isDestroyed = true;
    cancelRequest();
    jumpController?.abort();
    clearTimeout(refreshTimer); refreshTimer = 0;
    clearTimeout(bridgeTimer);
    window.removeEventListener('message', onConversationResponse);
    document.removeEventListener('keydown', cancelJumpOnInput, true);
    document.removeEventListener('wheel', cancelJumpOnInput, true);
    document.removeEventListener('touchstart', cancelJumpOnInput, true);
    document.removeEventListener('pointerdown', cancelJumpOnInput, true);
    observer.disconnect();
    themeObserver.disconnect();
    colorPreference.removeEventListener('change', updateTheme);
    clearInterval(routeTimer);
    clearTimeout(scanTimer);
    clearTimeout(saveTimer);
    cancelAnimationFrame(positionFrame);
    document.removeEventListener('keydown', onShortcut);
    document.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', schedulePosition);
    try {
      chrome.runtime.onMessage.removeListener(onMessage);
      chrome.storage.onChanged.removeListener(onStorage);
    } catch (_) { /* The context may already be gone. */ }
  }, { once: true });

  applySettings();
  pingBridge();
  scan();
})();
