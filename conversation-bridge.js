(() => {
  'use strict';

  // MAIN/document_start. Reuse only the website's successful current-conversation
  // GET responses. Never inspect request headers/body or unrelated API traffic.
  if (window !== window.top || location.protocol !== 'https:' || !['chatgpt.com', 'chat.openai.com'].includes(location.hostname)) return;
  const originalFetch = window.fetch;
  const nativeFetch = originalFetch.bind(window);
  const pageOrigin = location.origin;
  const requestSource = 'cgmap-extension';
  const responseSource = 'cgmap-page';
  const safeFailure = Symbol('safe bridge error');
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  let active = null;
  let lastStarted = 0;
  let lastConversation = '';
  let routePath = location.pathname;
  let routeVersion = 0;
  let cache = null;

  function currentConversationId() {
    const match = location.pathname.match(/^\/(?:g\/[^/]+\/)?c\/([a-zA-Z0-9_-]{1,128})\/?$/);
    return match ? match[1] : null;
  }

  function reply(conversationId, requestId, payload) {
    window.postMessage({source: responseSource, type: 'conversation-response', conversationId, requestId, ...payload}, pageOrigin);
  }

  function failure(code, message, stage, httpStatus) {
    const error = new Error(message);
    error[safeFailure] = true;
    error.code = code;
    error.stage = stage;
    if (Number.isInteger(httpStatus)) error.httpStatus = httpStatus;
    return error;
  }

  function cancelActive() {
    if (!active) return;
    active.controller.abort();
    clearTimeout(active.timeout);
    active = null;
  }

  function syncRoute() {
    if (routePath === location.pathname) return;
    routePath = location.pathname;
    routeVersion++;
    cache = null;
    lastConversation = '';
    cancelActive();
  }

  function isCurrent(snapshot) {
    syncRoute();
    return snapshot.version === routeVersion && snapshot.pathname === location.pathname && snapshot.conversationId === currentConversationId();
  }

  function assertCurrent(job) {
    if (!isCurrent(job) || active !== job || job.controller.signal.aborted) {
      throw failure('cancelled', '已切换对话，忽略旧请求。', 'route');
    }
  }

  function partial(object) {
    return object && typeof object === 'object' && (object.has_more === true || object.has_more_messages === true ||
      object.is_partial === true || object.partial === true || !!object.next_cursor || !!object.nextCursor || object.pagination?.has_more === true);
  }

  function fullConversation(value, stage = 'conversation-format') {
    // Accept known envelope variations, but never guess a branch or accept a page
    // of messages as a complete conversation. The selected chain must reach a root.
    const candidates = [value, value?.conversation, value?.data, value?.data?.conversation, value?.conversation?.data];
    if (partial(value)) throw failure('partial_data', '网页返回的是部分对话，尚未获得完整分支。', stage);
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== 'object' || !candidate.mapping || typeof candidate.mapping !== 'object' || Array.isArray(candidate.mapping)) continue;
      if (partial(candidate) || partial(value?.data) || partial(value?.conversation)) throw failure('partial_data', '网页返回的是部分对话，尚未获得完整分支。', stage);
      if (typeof candidate.current_node !== 'string' || !own(candidate.mapping, candidate.current_node)) continue;
      let id = candidate.current_node;
      const seen = new Set();
      while (id !== null) {
        if (typeof id !== 'string' || seen.has(id) || !own(candidate.mapping, id)) throw failure('partial_data', '对话分支尚不完整，请重新读取。', stage);
        seen.add(id);
        const node = candidate.mapping[id];
        if (!node || typeof node !== 'object' || !own(node, 'parent') || (node.parent !== null && typeof node.parent !== 'string')) {
          throw failure('partial_data', '对话分支尚不完整，请重新读取。', stage);
        }
        id = node.parent;
      }
      // Only the conversation tree crosses into the isolated extension; exclude
      // unrelated envelope/session fields even if the website adds them later.
      return {mapping: candidate.mapping, current_node: candidate.current_node};
    }
    throw failure('format', '未识别到完整会话数据，网页接口可能已经变化。', stage);
  }

  function observePageResponse(snapshot, response) {
    if (!isCurrent(snapshot) || !response?.ok) return;
    try {
      if (response.url) {
        const finalURL = new URL(response.url);
        if (finalURL.origin !== pageOrigin || finalURL.pathname !== snapshot.apiPath) return;
      }
      const contentType = response.headers?.get('content-type') || '';
      if (contentType && !/json/i.test(contentType)) return;
      const clone = response.clone();
      void clone.json().then(value => {
        if (!isCurrent(snapshot)) return;
        let data;
        try { data = fullConversation(value, 'page-response'); }
        catch { return; } // A partial/unsupported passive result cannot overwrite a complete index.
        cache = {...snapshot, data, at: Date.now()};
        if (active && isCurrent(active) && active.conversationId === snapshot.conversationId) {
          const requestIds = [...active.requests];
          cancelActive();
          for (const requestId of requestIds) reply(snapshot.conversationId, requestId, {data, via: 'page-fetch'});
        } else {
          window.postMessage({source: responseSource, type: 'conversation-update', conversationId: snapshot.conversationId, data, via: 'page-fetch'}, pageOrigin);
        }
      }).catch(() => {});
    } catch { /* Observing a consumed/unsupported response must never affect ChatGPT. */ }
  }

  function pageRequestSnapshot(input, init) {
    syncRoute();
    const conversationId = currentConversationId();
    if (!conversationId) return null;
    let rawURL;
    let method = 'GET';
    if (typeof input === 'string') rawURL = input;
    else if (typeof Request !== 'undefined' && input instanceof Request) { rawURL = input.url; method = input.method; }
    else if (input instanceof URL) rawURL = input.href;
    else return null; // Do not call arbitrary input.toString() a second time.
    if (init && typeof init === 'object') {
      let owner = init;
      let descriptor;
      for (let depth = 0; owner && depth < 8; depth++, owner = Object.getPrototypeOf(owner)) {
        descriptor = Object.getOwnPropertyDescriptor(owner, 'method');
        if (descriptor) break;
      }
      if (owner && !descriptor) return null;
      if (descriptor && !own(descriptor, 'value')) return null; // Never invoke an init getter twice.
      if (descriptor?.value !== undefined) method = descriptor.value;
    }
    if (typeof method !== 'string' || method.toUpperCase() !== 'GET') return null;
    const url = new URL(rawURL, location.href);
    const apiPath = `/backend-api/conversation/${conversationId}`;
    if (url.origin !== pageOrigin || url.pathname !== apiPath) return null;
    return {conversationId, pathname: location.pathname, version: routeVersion, apiPath};
  }

  // Return the exact original Promise and preserve arguments, receiver, errors and
  // response body. Cloning is a separate best-effort side observation only.
  try {
    window.fetch = function (...args) {
      const promise = Reflect.apply(originalFetch, this, args);
      try {
        const snapshot = pageRequestSnapshot(args[0], args[1]);
        if (snapshot) void promise.then(response => observePageResponse(snapshot, response), () => {}).catch(() => {});
      } catch { /* The original fetch result always wins. */ }
      return promise;
    };
  } catch { /* Readiness and direct reads still work if the page locks fetch. */ }

  // Capture route epochs even for A -> B -> A within a single polling interval.
  // Preserve history's native return values and throws as with fetch above.
  for (const method of ['pushState', 'replaceState']) {
    try {
      const original = window.history[method];
      window.history[method] = function (...args) {
        const result = Reflect.apply(original, this, args);
        try { syncRoute(); } catch { /* No change to website navigation semantics. */ }
        return result;
      };
    } catch { /* The periodic route guard remains available. */ }
  }
  window.addEventListener('popstate', syncRoute);
  setInterval(syncRoute, 250);

  async function get(job, path, stage, accessToken) {
    assertCurrent(job);
    job.stage = stage;
    const headers = {Accept: 'application/json'};
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    return nativeFetch(`${pageOrigin}${path}`, {
      method: 'GET', credentials: 'include', mode: 'same-origin', cache: 'no-store',
      redirect: 'error', headers, signal: job.controller.signal
    });
  }

  async function readConversation(job) {
    const path = `/backend-api/conversation/${encodeURIComponent(job.conversationId)}`;
    let response = await get(job, path, 'conversation-cookie');
    assertCurrent(job);
    // A cookie-only 404 is ambiguous: try the same one-shot login fallback
    // before treating it as unavailable. Never loop on an authenticated 404.
    if ([401, 403, 404].includes(response.status)) {
      // The fallback session token remains only in this function's memory. Never
      // store/log/forward the session response, token, request headers or API body.
      const sessionResponse = await get(job, '/api/auth/session', 'session');
      assertCurrent(job);
      if (!sessionResponse.ok) throw failure('authentication', '无法读取当前登录授权；请刷新网页后查看诊断信息。', 'session', sessionResponse.status);
      let session;
      try { session = await sessionResponse.json(); }
      catch { throw failure('session_format', '登录状态返回格式无法识别。', 'session', sessionResponse.status); }
      let accessToken = typeof session?.accessToken === 'string' ? session.accessToken : '';
      session = null;
      if (!accessToken) throw failure('authentication', '当前登录状态未提供读取授权。', 'session', sessionResponse.status);
      try { response = await get(job, path, 'conversation-authenticated', accessToken); }
      finally { accessToken = ''; }
      assertCurrent(job);
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw failure('authentication', '网页暂未允许直接读取；等待网页自身加载对话可尝试恢复。', job.stage, response.status);
      if (response.status === 404) throw failure('not_found', '已尝试登录授权，但完整会话接口仍返回 404；当前目录可能不完整。', job.stage, response.status);
      if (response.status === 429) throw failure('rate_limited', '读取过于频繁，请稍后重试。', job.stage, response.status);
      throw failure('http_error', '完整会话读取失败，请查看诊断信息。', job.stage, response.status);
    }
    job.stage = 'conversation-json';
    let value;
    try { value = await response.json(); }
    catch { throw failure('format', '会话响应不是可识别的 JSON 数据。', job.stage, response.status); }
    assertCurrent(job);
    return fullConversation(value);
  }

  async function start(conversationId, requestId, fresh) {
    syncRoute();
    if (!fresh && cache && isCurrent(cache) && Date.now() - cache.at <= 30000) {
      reply(conversationId, requestId, {data: cache.data, via: 'page-cache'});
      return;
    }
    if (active?.conversationId === conversationId) {
      if (active.requests.size < 8) active.requests.add(requestId);
      else reply(conversationId, requestId, {error: {code: 'rate_limited', stage: 'queue', message: '读取请求较多，请稍后重试。'}});
      return;
    }
    cancelActive();
    if (lastConversation === conversationId && Date.now() - lastStarted < 1200) {
      reply(conversationId, requestId, {error: {code: 'rate_limited', stage: 'queue', message: '正在更新对话，请稍后重新读取。'}});
      return;
    }
    lastStarted = Date.now();
    lastConversation = conversationId;
    const job = {conversationId, requests: new Set([requestId]), pathname: location.pathname, version: routeVersion,
      controller: new AbortController(), timedOut: false, timeout: null, stage: 'conversation-cookie'};
    active = job;
    job.timeout = setTimeout(() => { job.timedOut = true; job.controller.abort(); }, 25000);
    try {
      const data = await readConversation(job);
      assertCurrent(job);
      for (const id of job.requests) reply(conversationId, id, {data, via: 'bridge-fetch'});
    } catch (error) {
      if (active !== job || !isCurrent(job)) return;
      if (job.controller.signal.aborted && !job.timedOut) return;
      const safeError = job.timedOut
        ? {code: 'timeout', stage: job.stage, message: '完整对话读取超时，请重新读取。'}
        : error?.[safeFailure]
          ? {code: error.code, stage: error.stage, message: error.message, ...(error.httpStatus !== undefined ? {httpStatus: error.httpStatus} : {})}
          : {code: 'network', stage: job.stage, message: '网页请求未完成，请检查网络或查看诊断信息。'};
      for (const id of job.requests) reply(conversationId, id, {error: safeError});
    } finally {
      clearTimeout(job.timeout);
      if (active === job) active = null;
    }
  }

  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== pageOrigin) return;
    const message = event.data;
    if (!message || message.source !== requestSource || typeof message.requestId !== 'string' || !message.requestId || message.requestId.length > 160) return;
    syncRoute();
    if (message.type === 'bridge-ping') {
      window.postMessage({source: responseSource, type: 'bridge-ready', requestId: message.requestId, version: '1.2.2'}, pageOrigin);
      return;
    }
    if (message.type === 'conversation-cancel') {
      if (active?.conversationId === message.conversationId && active.requests.has(message.requestId)) {
        active.requests.delete(message.requestId);
        if (!active.requests.size) cancelActive();
      }
      return;
    }
    if (message.type !== 'conversation-request') return;
    const conversationId = currentConversationId();
    if (!conversationId || message.conversationId !== conversationId) return;
    void start(conversationId, message.requestId, message.fresh === true);
  });
  window.addEventListener('pagehide', () => { cancelActive(); cache = null; routeVersion++; });
})();