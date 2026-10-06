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

  // ChatGPT now uses durable ids such as `WEB:<uuid>` during some web
  // sessions. Keep the route parser segment-based so encoded colons and
  // custom-GPT prefixes remain valid without accepting another path segment.
  function currentConversationId(pathname = location.pathname) {
    const parts = String(pathname || '').split('/').filter(Boolean);
    const marker = parts.lastIndexOf('c');
    const supportedShape = (parts.length === 2 && marker === 0) || (parts.length === 4 && parts[0] === 'g' && marker === 2);
    if (!supportedShape || marker !== parts.length - 2) return null;
    try {
      const id = decodeURIComponent(parts[marker + 1]);
      return /^[a-zA-Z0-9_:-]{1,256}$/.test(id) ? id : null;
    } catch { return null; }
  }

  function isConversationEndpoint(pathname, conversationId) {
    const prefix = String(pathname || '').startsWith('/backend-api/conversations/')
      ? '/backend-api/conversations/'
      : String(pathname || '').startsWith('/backend-api/conversation/')
        ? '/backend-api/conversation/' : '';
    if (!prefix) return false;
    try {
      const tail = decodeURIComponent(String(pathname).slice(prefix.length));
      return tail === conversationId || tail.startsWith(conversationId + '/');
    } catch { return false; }
  }

  function reply(conversationId, requestId, payload) {
    window.postMessage({source: responseSource, type: 'conversation-response', conversationId, requestId, ...payload}, pageOrigin);
  }

  function progress(conversationId, requestId, stage) {
    window.postMessage({source: responseSource, type: 'conversation-progress', conversationId, requestId, stage}, pageOrigin);
  }

  function reportProgress(job, stage) {
    assertCurrent(job);
    job.stage = stage;
    for (const requestId of job.requests) progress(job.conversationId, requestId, stage);
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
        if (finalURL.origin !== pageOrigin || !isConversationEndpoint(finalURL.pathname, snapshot.conversationId)) return;
      }
      const contentType = response.headers?.get('content-type') || '';
      if (contentType && !/json/i.test(contentType)) return;
      const clone = response.clone();
      void clone.json().then(value => {
        if (!isCurrent(snapshot)) return;
        let data;
        try {
          // A plural response without an older page is complete on its own;
          // a paginated response is left to the direct reader so it can fetch
          // every cursor before replacing the index.
          data = flatItems(value) && !flatPageInfo(value).hasPrevious
            ? flatConversation([value]) : fullConversation(value, 'page-response');
        }
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
    if (url.origin !== pageOrigin || !isConversationEndpoint(url.pathname, conversationId)) return null;
    return {conversationId, pathname: location.pathname, version: routeVersion, apiPath: url.pathname};
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
    reportProgress(job, stage);
    const headers = {Accept: 'application/json'};
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    return nativeFetch(`${pageOrigin}${path}`, {
      method: 'GET', credentials: 'include', mode: 'same-origin', cache: 'no-store',
      redirect: 'error', headers, signal: job.controller.signal
    });
  }

  function flatPageInfo(value) {
    const info = value?.page_info || value?.pageInfo || value?.pagination || value?.data?.page_info || value?.data?.pageInfo || {};
    const cursor = info.start_cursor ?? info.startCursor ?? info.before ?? '';
    const hasPrevious = info.has_previous_page ?? info.hasPreviousPage ?? info.has_more ?? info.hasMore ?? false;
    return {hasPrevious: hasPrevious === true, cursor: typeof cursor === 'string' ? cursor : ''};
  }

  function flatItems(value) {
    if (Array.isArray(value?.messages)) return value.messages;
    if (Array.isArray(value?.data?.messages)) return value.data.messages;
    if (Array.isArray(value?.conversation?.messages)) return value.conversation.messages;
    return null;
  }

  function flatItemId(item, fallback) {
    const message = item?.message && typeof item.message === 'object' ? item.message : item;
    const id = item?.node_id || item?.nodeId || item?.message_id || item?.messageId || item?.id || message?.id;
    return typeof id === 'string' && id ? id : `cgmap-flat-${fallback}`;
  }

  function flatItemMessage(item) {
    if (item?.message && typeof item.message === 'object') return item.message;
    return item && typeof item === 'object' ? item : null;
  }

  function flatConversation(pages) {
    const pageValues = pages.filter(value => flatItems(value));
    if (!pageValues.length) throw failure('format', '未识别到完整会话数据，网页接口可能已经变化。', 'conversation-json');
    const pageItems = pageValues.map(value => {
      const items = flatItems(value).filter(item => flatItemMessage(item));
      const current = typeof value.current_node === 'string' ? value.current_node : typeof value?.data?.current_node === 'string' ? value.data.current_node : '';
      const ids = items.map((item, index) => flatItemId(item, index));
      const currentIndex = current ? ids.findIndex(id => id === current || flatItemMessage(items[ids.indexOf(id)])?.id === current) : -1;
      if (currentIndex === 0 && items.length > 1) items.reverse();
      else if (currentIndex < 0 && items.length > 1) {
        const first = Number(flatItemMessage(items[0])?.create_time);
        const last = Number(flatItemMessage(items.at(-1))?.create_time);
        if (Number.isFinite(first) && Number.isFinite(last) && first > last) items.reverse();
      }
      return items;
    });
    // `before=start_cursor` returns older pages. Restore chronological order
    // and deduplicate message ids when the web client overlaps page boundaries.
    const items = pageItems.reverse().flat();
    const seen = new Set();
    const ordered = items.filter((item, index) => {
      const id = flatItemId(item, index);
      if (seen.has(id)) return false;
      seen.add(id); return true;
    });
    if (!ordered.length) throw failure('partial_data', '当前会话没有可读消息，请重新读取。', 'conversation-json');
    const mapping = {};
    let parent = null;
    const ids = [];
    for (let index = 0; index < ordered.length; index++) {
      const nodeId = flatItemId(ordered[index], index);
      const message = flatItemMessage(ordered[index]);
      mapping[nodeId] = {id: nodeId, parent, children: [], message};
      if (parent && mapping[parent]) mapping[parent].children.push(nodeId);
      ids.push(nodeId); parent = nodeId;
    }
    const requested = pageValues.at(0)?.current_node || pageValues.at(0)?.data?.current_node;
    const currentNode = typeof requested === 'string' && mapping[requested] ? requested : ids.at(-1);
    return {mapping, current_node: currentNode};
  }

  async function accessToken(job) {
    const sessionResponse = await get(job, '/api/auth/session', 'session');
    assertCurrent(job);
    if (!sessionResponse.ok) return '';
    reportProgress(job, 'session-json');
    let session;
    try { session = await sessionResponse.json(); }
    catch { return ''; }
    assertCurrent(job);
    const token = typeof session?.accessToken === 'string' ? session.accessToken
      : typeof session?.access_token === 'string' ? session.access_token
        : typeof session?.user?.accessToken === 'string' ? session.user.accessToken : '';
    session = null;
    return token;
  }

  async function getWithAuth(job, path, knownToken = '') {
    let response = await get(job, path, 'conversation-cookie');
    assertCurrent(job);
    let token = knownToken;
    if ([401, 403, 404].includes(response.status)) {
      // The token remains in this function's memory only. A 404 is also used
      // when an account has not rolled out the plural endpoint, so preserve it
      // as a fallback signal if the session endpoint is unavailable.
      if (!token) token = await accessToken(job);
      if (token) {
        response = await get(job, path, 'conversation-authenticated', token);
        assertCurrent(job);
      }
    }
    return {response, token};
  }

  async function readFlatPages(job, first, basePath, token) {
    const pages = [first];
    const cursors = new Set();
    let current = first;
    for (let page = 0; page < 50; page++) {
      const info = flatPageInfo(current);
      if (!info.hasPrevious) return flatConversation(pages);
      if (!info.cursor || cursors.has(info.cursor)) throw failure('partial_data', '会话分页未能完整读取，请重新读取。', 'conversation-pages');
      cursors.add(info.cursor);
      reportProgress(job, 'conversation-pages');
      const separator = basePath.includes('?') ? '&' : '?';
      const nextPath = `${basePath}${separator}before=${encodeURIComponent(info.cursor)}`;
      const next = await get(job, nextPath, 'conversation-pages', token);
      assertCurrent(job);
      if (!next.ok) throw failure(next.status === 429 ? 'rate_limited' : 'http_error', '会话分页读取失败，请查看诊断信息。', 'conversation-pages', next.status);
      try { current = await next.json(); }
      catch { throw failure('format', '会话分页不是可识别的 JSON 数据。', 'conversation-pages', next.status); }
      assertCurrent(job);
      if (!flatItems(current)) throw failure('format', '会话分页格式已变化，无法确认完整对话。', 'conversation-pages', next.status);
      pages.push(current);
    }
    throw failure('partial_data', '会话分页数量超过安全上限，未确认完整读取。', 'conversation-pages');
  }

  async function readConversation(job) {
    const encodedId = encodeURIComponent(job.conversationId);
    const pluralPath = `/backend-api/conversations/${encodedId}?include_has_versions=true&num_turns=100`;
    const singularPath = `/backend-api/conversation/${encodedId}`;
    let endpoint = await getWithAuth(job, pluralPath);
    let token = endpoint.token;
    let endpointPath = pluralPath;
    // The singular mapping endpoint remains available on some accounts and
    // is also useful for older ChatGPT deployments.
    if (!endpoint.response.ok && [404, 405, 422].includes(endpoint.response.status)) {
      endpoint = await getWithAuth(job, singularPath, token);
      token = endpoint.token;
      endpointPath = singularPath;
    }
    let {response} = endpoint;
    assertCurrent(job);
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw failure('authentication', '网页暂未允许直接读取；等待网页自身加载对话可尝试恢复。', job.stage, response.status);
      if (response.status === 404) throw failure('not_found', '当前会话接口返回 404；请确认这条对话仍可在网页中打开。', job.stage, response.status);
      if (response.status === 429) throw failure('rate_limited', '读取过于频繁，请稍后重试。', job.stage, response.status);
      throw failure('http_error', '完整会话读取失败，请查看诊断信息。', job.stage, response.status);
    }
    async function parseSingularFallback() {
      endpoint = await getWithAuth(job, singularPath, token);
      token = endpoint.token;
      endpointPath = singularPath;
      response = endpoint.response;
      assertCurrent(job);
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) throw failure('authentication', '网页暂未允许直接读取；等待网页自身加载对话可尝试恢复。', job.stage, response.status);
        if (response.status === 404) throw failure('not_found', '当前会话接口返回 404；请确认这条对话仍可在网页中打开。', job.stage, response.status);
        throw failure('http_error', '完整会话读取失败，请查看诊断信息。', job.stage, response.status);
      }
      reportProgress(job, 'conversation-json');
      let singular;
      try { singular = await response.json(); }
      catch { throw failure('format', '会话响应不是可识别的 JSON 数据。', job.stage, response.status); }
      assertCurrent(job);
      return fullConversation(singular);
    }
    reportProgress(job, 'conversation-json');
    let value;
    try { value = await response.json(); }
    catch {
      // Older deployments may answer the new plural URL with an HTML route
      // shell. Retry the known mapping endpoint before reporting a format error.
      if (endpointPath === pluralPath) return parseSingularFallback();
      throw failure('format', '会话响应不是可识别的 JSON 数据。', job.stage, response.status);
    }
    assertCurrent(job);
    if (flatItems(value)) return readFlatPages(job, value, pluralPath, token);
    if (endpointPath === pluralPath) {
      try { return fullConversation(value); }
      catch (error) {
        if (error?.code === 'format' || error?.code === 'partial_data') return parseSingularFallback();
        throw error;
      }
    }
    return fullConversation(value);
  }

  async function start(conversationId, requestId, fresh) {
    syncRoute();
    if (!fresh && cache && isCurrent(cache) && Date.now() - cache.at <= 30000) {
      reply(conversationId, requestId, {data: cache.data, via: 'page-cache'});
      return;
    }
    if (active?.conversationId === conversationId) {
      if (active.requests.size < 8) {
        active.requests.add(requestId);
        progress(conversationId, requestId, active.stage);
      }
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
    job.timeout = setTimeout(() => {
      if (active !== job || !isCurrent(job)) return;
      // Publish the timeout independently of fetch/JSON settlement. Some page
      // fetch wrappers ignore AbortSignal; neither their eventual data nor errors
      // may complete this request a second time or keep the active slot occupied.
      const requestIds = [...job.requests];
      const stage = job.stage;
      job.timedOut = true;
      active = null;
      clearTimeout(job.timeout);
      job.controller.abort();
      for (const id of requestIds) reply(conversationId, id, {
        error: {code: 'timeout', stage, message: '完整对话读取超时，请重新读取。'}
      });
    }, 25000);
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
      window.postMessage({source: responseSource, type: 'bridge-ready', requestId: message.requestId, version: '1.3.5', routeSupported: currentConversationId() !== null}, pageOrigin);
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
    if (typeof message.conversationId !== 'string' || !/^[a-zA-Z0-9_:-]{1,256}$/.test(message.conversationId)) return;
    const conversationId = currentConversationId();
    if (!conversationId) {
      reply(message.conversationId, message.requestId, {error: {
        code: 'unsupported_route', stage: 'route', message: '当前网页地址结构尚不支持完整读取，请复制诊断以便确认。'
      }});
      return;
    }
    if (message.conversationId !== conversationId) {
      reply(message.conversationId, message.requestId, {error: {
        code: 'route_mismatch', stage: 'route', message: '读取请求与当前对话不一致，请重新读取当前对话。'
      }});
      return;
    }
    progress(conversationId, message.requestId, 'accepted');
    void start(conversationId, message.requestId, message.fresh === true);
  });
  window.addEventListener('pagehide', () => { cancelActive(); cache = null; routeVersion++; });
})();
