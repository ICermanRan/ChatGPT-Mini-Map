/* Text-based fallback for page layouts without stable ChatGPT message attributes. */
(() => {
  'use strict';

  const BLOCK_TAGS = new Set(['ADDRESS','ARTICLE','BLOCKQUOTE','DIV','DL','DT','DD','FIGCAPTION','FIGURE','H1','H2','H3','H4','H5','H6','LI','OL','P','PRE','SECTION','TABLE','TD','TH','TR','UL']);
  const OMIT = 'script,style,noscript,template,svg,canvas,iframe,object,embed,button,[role="button"],input,textarea,select,option,label,nav,aside,footer,form,header,[role="navigation"],[role="search"],[role="toolbar"],[role="menu"],[role="dialog"],[contenteditable]:not([contenteditable="false"]),[hidden],[aria-hidden="true"],[inert],#cgmap-root,.katex-mathml';
  const NOT_ANCHOR = 'pre,code,blockquote,q,a,button,label,nav,aside,form,[role="button"],[role="navigation"],[role="toolbar"],[role="log"],[role="list"]';
  const MAX_TEXT_NODES = 18000;
  const MAX_CANDIDATES = 14000;
  const MAX_ANCESTORS = 18;
  let lastStats = {};
  let cachedModel = null;
  let cachedDom = null;

  // Preserve case and punctuation: symbols and case can distinguish two questions.
  function textKey(value) {
    return String(value || '').replace(/\u200B/g, '').replace(/\s+/g, ' ').trim();
  }

  function inlineMarkdown(value) {
    return value.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/<((?:https?:\/\/|mailto:)[^>]+)>/g, '$1')
      .replace(/(`+)([^`\n]*?)\1/g, '$2')
      .replace(/\*\*([^\n]+?)\*\*/g, '$1').replace(/__([^\n]+?)__/g, '$1')
      .replace(/(?<!\w)\*([^*\n]+)\*(?!\w)/g, '$1').replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, '$1')
      .replace(/~~([^\n]+?)~~/g, '$1')
      .replace(/\\([\\`*_{}\[\]()#+.!>|~-])/g, '$1')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  }

  function renderedMarkdown(value) {
    const output = [];
    let fence = null;
    for (const rawLine of String(value || '').split(/\r?\n/)) {
      const delimiter = rawLine.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
      if (fence) {
        if (delimiter && delimiter[1][0] === fence[0] && delimiter[1].length >= fence.length && !delimiter[2].trim()) fence = null;
        else output.push(rawLine);
        continue;
      }
      if (delimiter) { fence = delimiter[1]; continue; }
      if (/^ {0,3}(?:=+|-+)\s*$/.test(rawLine) && output.length) continue;
      if (/^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/.test(rawLine)) continue;
      let line = rawLine.replace(/^ {0,3}#{1,6}(?:\s+|$)/, '').replace(/\s+#+\s*$/, '')
        .replace(/^\s*(?:>\s*)+/, '').replace(/^\s*(?:[-+*]|\d+[.)])\s+/, '');
      if (/^\s*\|.*\|\s*$/.test(line)) line = line.replace(/^\s*\||\|\s*$/g, '').split('|').join(' ');
      output.push(inlineMarkdown(line));
    }
    return textKey(output.join('\n'));
  }

  function modelFor(records) {
    const source = records.filter(record => record && (record.role === 'user' || record.role === 'assistant') && typeof record.id === 'string' && typeof record.text === 'string');
    if (cachedModel && source.length === cachedModel.snapshot.length && source.every((record, index) => {
      const old = cachedModel.snapshot[index];
      return record === old.record && record.id === old.id && record.role === old.role && record.text === old.text;
    })) return cachedModel;
    const index = new Map();
    const assistantTexts = [];
    let maximumLength = 0;
    const add = (key, record) => {
      if (!key) return;
      maximumLength = Math.max(maximumLength, key.length);
      const values = index.get(key) || [];
      if (!values.includes(record)) values.push(record);
      index.set(key, values);
    };
    for (const record of source) {
      const key = textKey(record.text);
      add(key, record);
      if (record.role === 'assistant') {
        const rendered = renderedMarkdown(record.text);
        add(rendered, record);
        assistantTexts.push(rendered);
      }
    }
    cachedModel = { index, assistantTexts, maximumLength, records: source, indices: new Map(source.map((record, index) => [record.id, index])), snapshot: source.map(record => ({ record, id: record.id, role: record.role, text: record.text })) };
    return cachedModel;
  }

  function labelRole(value) {
    const text = textKey(value).replace(/[:：]\s*$/, '').toLocaleLowerCase();
    if (/^(?:you said|you|user|你说|您说|你说了|用户|vous avez dit|du hast gesagt|tú dijiste|você disse|hai detto|вы сказали|あなた|ユーザー)$/.test(text)) return 'user';
    if (/^(?:chatgpt said|chatgpt 说|chatgpt说|chatgpt|assistant|助手|アシスタント)$/.test(text)) return 'assistant';
    return null;
  }

  function roleHeading(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return null;
    const heading = /^H[1-6]$/.test(element.tagName) || element.getAttribute('role') === 'heading';
    const visuallyHidden = /(?:^|\s)(?:sr-only|visually-hidden)(?:\s|$)/.test(element.className || '');
    const explicitLabel = /^(?:you said|chatgpt said|你说|您说|你说了|chatgpt\s*说|vous avez dit|du hast gesagt|tú dijiste|você disse|hai detto|вы сказали)[:：]?$/i.test(textKey(element.textContent));
    // An ordinary answer heading named "User" or "ChatGPT" is content, not a speaker label.
    const articleHeading = heading && element.parentElement?.matches('article,[role="article"]');
    return visuallyHidden || (explicitLabel && (articleHeading || element.tagName === 'SMALL')) ? labelRole(element.textContent) : null;
  }
  function saveDomCache(main, model, rows) {
    if (!cachedDom || cachedDom.main !== main) {
      if (cachedDom) cachedDom.observer.disconnect();
      const state = { main, model: null, rows: [], stats: {}, dirty: true, viewport: '', observer: null };
      state.observer = new MutationObserver(() => { state.dirty = true; });
      state.observer.observe(main, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class','style','hidden','inert','aria-hidden','aria-label','aria-labelledby','role','contenteditable'] });
      cachedDom = state;
    }
    cachedDom.observer.takeRecords();
    cachedDom.model = model;
    cachedDom.rows = rows.map(row => ({ ...row }));
    cachedDom.stats = { ...lastStats };
    cachedDom.viewport = `${window.innerWidth}:${window.innerHeight}`;
    cachedDom.dirty = false;
    cachedDom.at = performance.now();
  }
  function find(main, records) {
    lastStats = { modelMessages: Array.isArray(records) ? records.length : 0, textNodes: 0, candidateContainers: 0, textMatches: 0, matchedMessages: 0, matchedUsers: 0, matchedAssistants: 0, ambiguous: 0, skippedRegions: 0, limited: false, failed: false };
    if (!main || !main.isConnected || !Array.isArray(records) || !records.length) {
      if (cachedDom) cachedDom.observer.disconnect();
      cachedDom = null;
      cachedModel = null;
      return [];
    }
    try {
      const model = modelFor(records);
      if (cachedDom && cachedDom.main === main && cachedDom.model === model) {
        if (cachedDom.observer.takeRecords().length) cachedDom.dirty = true;
        if (!cachedDom.dirty && performance.now() - cachedDom.at < 300 && cachedDom.viewport === `${window.innerWidth}:${window.innerHeight}` && cachedDom.rows.every(row => {
          if (!row.node.isConnected || !row.node.getClientRects().length || row.node.closest('[hidden],[aria-hidden="true"],[inert]')) return false;
          const style = getComputedStyle(row.node);
          return style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse';
        })) {
          lastStats = { ...cachedDom.stats, cached: true };
          return cachedDom.rows.map(row => ({ ...row }));
        }
      }
      const aggregates = new Map();
      const blockCache = new WeakMap();
      const renderedCache = new WeakMap();
      const roleCache = new WeakMap();
      const maximumChars = Math.min(2000000, Math.max(2048, model.maximumLength * 3 + 1024));
      function rendered(element) {
        if (renderedCache.has(element)) return renderedCache.get(element);
        const style = getComputedStyle(element);
        const visible = !element.closest('[hidden],[aria-hidden="true"],[inert]') && style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse' && Array.from(element.getClientRects()).some(rect => rect.width > 0 && rect.height > 0);
        renderedCache.set(element, visible);
        return visible;
      }
      function blockFor(element) {
        if (blockCache.has(element)) return blockCache.get(element);
        let block = element;
        while (block && block !== main && !BLOCK_TAGS.has(block.tagName)) block = block.parentElement;
        blockCache.set(element, block);
        return block;
      }
      function append(node, value) {
        const parent = node.nodeType === Node.TEXT_NODE ? node.parentElement : node.parentElement;
        if (!parent) return;
        const block = blockFor(parent);
        for (let ancestor = parent, depth = 0; ancestor && ancestor !== main && depth < MAX_ANCESTORS; ancestor = ancestor.parentElement, depth++) {
          if (ancestor.matches(NOT_ANCHOR) || ancestor.closest('pre,code,blockquote,q')) continue;
          let aggregate = aggregates.get(ancestor);
          if (!aggregate) {
            if (aggregates.size >= MAX_CANDIDATES) { lastStats.limited = true; return; }
            aggregate = { node: ancestor, chunks: [], block: null, length: 0, oversized: false, key: null };
            aggregates.set(ancestor, aggregate);
          }
          if (aggregate.oversized) continue;
          aggregate.length += value.length;
          if (aggregate.length > maximumChars) { aggregate.oversized = true; aggregate.chunks = []; continue; }
          if (aggregate.block && aggregate.block !== block) aggregate.chunks.push(' ');
          aggregate.chunks.push(value);
          aggregate.block = block;
        }
      }
      const walker = document.createTreeWalker(main, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.matches(OMIT) || roleHeading(node)) { lastStats.skippedRegions++; return NodeFilter.FILTER_REJECT; }
            const style = getComputedStyle(node);
            if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') { lastStats.skippedRegions++; return NodeFilter.FILTER_REJECT; }
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      });
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.nodeType === Node.TEXT_NODE) {
          if (++lastStats.textNodes > MAX_TEXT_NODES) { lastStats.limited = true; break; }
          append(node, node.nodeValue || '');
        } else if (node.tagName === 'BR') append(node, ' ');
        if (lastStats.limited) break;
      }
      lastStats.candidateContainers = aggregates.size;
      // Never mistake an interrupted scan for a complete message body.
      if (lastStats.limited) return [];
      function keyFor(element) {
        const aggregate = aggregates.get(element);
        if (!aggregate || aggregate.oversized) return '';
        if (aggregate.key === null) aggregate.key = textKey(aggregate.chunks.join(''));
        return aggregate.key;
      }
      function semanticRole(element) {
        if (roleCache.has(element)) return roleCache.get(element);
        // An explicit message author's ARIA label wins over a quoted "You said"
        // heading inside the answer body.
        for (let node = element, depth = 0; node && node !== main && depth < MAX_ANCESTORS; node = node.parentElement, depth++) {
          let explicit = labelRole(node.getAttribute('aria-label'));
          if (!explicit) {
            const references = (node.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean).slice(0, 4);
            const roles = new Set(references.map(id => labelRole(document.getElementById(id)?.textContent)).filter(Boolean));
            if (roles.size === 1) explicit = Array.from(roles)[0];
          }
          if (explicit) { roleCache.set(element, explicit); return explicit; }
        }
        let role = null;
        for (let node = element, depth = 0; node && node !== main && depth < MAX_ANCESTORS; node = node.parentElement, depth++) {
          role = labelRole(node.getAttribute('aria-label'));
          if (!role) {
            const references = (node.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean).slice(0, 4);
            const roles = new Set(references.map(id => labelRole(document.getElementById(id)?.textContent)).filter(Boolean));
            if (roles.size === 1) role = Array.from(roles)[0];
          }
          if (role) break;
          // The role label can be a preceding sr-only h5 in the same article.
          for (let sibling = node.previousElementSibling, count = 0; sibling && count < 5; sibling = sibling.previousElementSibling, count++) {
            role = roleHeading(sibling);
            if (role || keyFor(sibling)) break;
          }
          if (role) break;
          const directRoles = new Set(Array.from(node.children).slice(0, 12).map(child => roleHeading(child)).filter(Boolean));
          if (directRoles.size === 1) { role = Array.from(directRoles)[0]; break; }
          if (directRoles.size > 1) break;
        }
        roleCache.set(element, role);
        return role;
      }

      const byBoundary = new Map();
      for (const aggregate of aggregates.values()) {
        const key = keyFor(aggregate.node);
        const allCandidates = model.index.get(key);
        if (!allCandidates || !rendered(aggregate.node)) continue;
        const role = semanticRole(aggregate.node);
        const candidates = role ? allCandidates.filter(record => record.role === role) : allCandidates;
        if (!candidates.length) continue;
        // Without an explicit role, identical user/assistant text cannot identify a message.
        if (!role && new Set(candidates.map(record => record.role)).size > 1) { lastStats.ambiguous++; continue; }
        lastStats.textMatches++;
        let boundary = aggregate.node;
        while (boundary.parentElement && boundary.parentElement !== main && keyFor(boundary.parentElement) === key) boundary = boundary.parentElement;
        const existing = byBoundary.get(boundary);
        if (!existing) byBoundary.set(boundary, { boundary, node: aggregate.node, key, role, candidates, record: null });
        else if (existing.node.contains(aggregate.node)) { existing.node = aggregate.node; existing.role = role || existing.role; }
      }
      let groups = Array.from(byBoundary.values());
      const assistantRoots = groups.filter(group => group.candidates.every(record => record.role === 'assistant'));
      function independentMessage(group) {
        if (group.boundary.matches('article,[role="article"]')) return true;
        if (group.candidates.length !== 1) return false;
        return groups.some(other => {
          if (other === group || other.boundary.parentElement !== group.boundary.parentElement || other.candidates.length !== 1 || other.candidates[0].role !== 'assistant') return false;
          const otherId = other.candidates[0].id;
          if (groups.filter(item => item.candidates.length === 1 && item.candidates[0].id === otherId).length !== 1) return false;
          const difference = model.indices.get(otherId) - model.indices.get(group.candidates[0].id);
          if (Math.abs(difference) !== 1) return false;
          const follows = !!(group.boundary.compareDocumentPosition(other.boundary) & Node.DOCUMENT_POSITION_FOLLOWING);
          return difference > 0 ? follows : !follows;
        });
      }
      groups = groups.filter(group => {
        // A naked short string such as "Copy" can also be unmarked page chrome.
        if (!group.role && group.key.length < 24 && !independentMessage(group)) { lastStats.ambiguous++; return false; }
        if (!group.candidates.some(record => record.role === 'user')) return true;
        if (assistantRoots.some(other => other !== group && other.boundary.contains(group.node))) return false;
        if (group.role === 'user') return true;
        if (!model.assistantTexts.some(text => text.includes(group.key))) return true;
        // If a question is repeated inside an answer, require an independent
        // message article or an already unique adjacent assistant message body.
        return independentMessage(group);
      });      groups.sort((a, b) => a.node === b.node ? 0 : a.node.compareDocumentPosition(b.node) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
      const claimCounts = new Map();
      for (const group of groups) if (group.candidates.length === 1) claimCounts.set(group.candidates[0].id, (claimCounts.get(group.candidates[0].id) || 0) + 1);
      const claimed = new Set();
      for (const group of groups) {
        if (group.candidates.length === 1 && claimCounts.get(group.candidates[0].id) === 1) {
          group.record = group.candidates[0];
          claimed.add(group.record.id);
        }
      }
      for (let pass = 0; pass < 2; pass++) {
        for (let index = 0; index < groups.length; index++) {
          const group = groups[index];
          if (group.record || !group.role) continue;
          let before = -1, after = model.records.length;
          for (let prior = index - 1; prior >= 0; prior--) if (groups[prior].record) { before = model.indices.get(groups[prior].record.id); break; }
          for (let next = index + 1; next < groups.length; next++) if (groups[next].record) { after = model.indices.get(groups[next].record.id); break; }
          if (before < 0 || after >= model.records.length || before >= after) continue;
          const choices = group.candidates.filter(record => !claimed.has(record.id) && model.indices.get(record.id) > before && model.indices.get(record.id) < after);
          if (choices.length !== 1 || groups.some(other => other !== group && !other.record && other.candidates.length === 1 && other.candidates[0].id === choices[0].id)) continue;
          group.record = choices[0];
          claimed.add(group.record.id);
        }
      }
      const output = [];
      for (const group of groups) {
        if (!group.record) { lastStats.ambiguous++; continue; }
        let node = group.node;
        // Keep a lone rendered heading inside the assistant anchor, so title
        // navigation can still query h1/h2/h3 as descendants of the message.
        if (group.record.role === 'assistant') {
          const heading = node.closest('h1,h2,h3');
          if (heading && group.boundary.contains(heading) && heading.parentElement && keyFor(heading.parentElement) === group.key) node = heading.parentElement;
        }
        if (!node.isConnected || !rendered(node)) continue;
        output.push({ node, role: group.record.role, recordId: group.record.id });
        lastStats[group.record.role === 'user' ? 'matchedUsers' : 'matchedAssistants']++;
      }
      lastStats.matchedMessages = output.length;
      saveDomCache(main, model, output);
      return output;
    } catch (_) {
      lastStats.failed = true;
      return [];
    }
  }

  globalThis.CGMapLocator = Object.freeze({ find, stats: () => ({ ...lastStats }) });
})();
