/* Shared discovery of ChatGPT's mounted messages and their actual page region. */
(() => {
  'use strict';

  const MESSAGE_SELECTOR = [
    '[data-message-author-role="user"]', '[data-message-author-role="assistant"]',
    '[data-chatgpt-search-unit-key$=":user"]', '[data-chatgpt-search-unit-key$=":assistant"]',
    '[data-turn="user"]', '[data-turn="assistant"]',
    '[data-testid^="conversation-turn-"]'
  ].join(',');
  const BODY_SELECTOR = '.markdown,[data-markdown-text-style="assistant-message"],.whitespace-pre-wrap,[data-message-content],[data-chatgpt-search-message-content]';
  const USER_BODY_SELECTOR = '.whitespace-pre-wrap,[data-message-content],[data-chatgpt-search-message-content]';
  const EXCLUDED = '#cgmap-root,nav,aside,[role="navigation"],[role="toolbar"],pre,code,blockquote,q,textarea,input,[contenteditable="true"],[role="textbox"]';
  let lastStats = {};

  function visible(node) {
    if (!node?.isConnected || node.closest('[hidden],[aria-hidden="true"],[inert]')) return false;
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    return Array.from(node.getClientRects()).some(rect => rect.width > 0 && rect.height > 0);
  }

  function roleFor(node) {
    const author = node.getAttribute('data-message-author-role');
    if (author === 'user' || author === 'assistant') return author;
    const unit = node.getAttribute('data-chatgpt-search-unit-key') || '';
    if (unit.endsWith(':user')) return 'user';
    if (unit.endsWith(':assistant')) return 'assistant';
    const turn = node.getAttribute('data-turn');
    if (turn === 'user' || turn === 'assistant') return turn;
    const label = (node.getAttribute('aria-label') || '').trim().toLocaleLowerCase();
    if (/^(you said|你说|您说|你说了)[:：]?$/.test(label)) return 'user';
    if (/^(chatgpt said|chatgpt\s*说)[:：]?$/.test(label)) return 'assistant';
    return null;
  }

  function targetFor(node) {
    if (visible(node)) return node;
    // display:contents markers identify a message but have no rectangle.
    // A rendered body keeps that identity while providing a scroll anchor.
    if (node.closest('[hidden],[aria-hidden="true"],[inert]')) return null;
    const style = getComputedStyle(node);
    if (style.display !== 'contents' || style.visibility === 'hidden' || style.visibility === 'collapse') return null;
    return Array.from(node.querySelectorAll(BODY_SELECTOR)).find(visible) || null;
  }

  function bodyFor(node, role, expectedText = '') {
    if (!node) return null;
    const selector = role === 'user' ? USER_BODY_SELECTOR : BODY_SELECTOR;
    let candidates = Array.from(node.matches?.(selector) ? [node] : node.querySelectorAll(selector))
      .filter(visible);
    const expected = String(expectedText || '').replace(/\u200B/g, '').replace(/\s+/g, ' ').trim();
    if (!candidates.length && role === 'user' && expected) {
      candidates = Array.from(node.querySelectorAll('p,div,span')).filter(candidate => {
        if (!visible(candidate)) return false;
        const text = (candidate.innerText || candidate.textContent || '').replace(/\u200B/g, '').replace(/\s+/g, ' ').trim();
        return text && (text === expected || text.includes(expected));
      });
    }
    if (!candidates.length) return null;
    if (role !== 'user') return candidates[0];
    if (expected) {
      const exact = candidates.find(candidate => (candidate.innerText || candidate.textContent || '').replace(/\u200B/g, '').replace(/\s+/g, ' ').trim() === expected);
      if (exact) return exact;
      const contained = candidates.filter(candidate => {
        const text = (candidate.innerText || candidate.textContent || '').replace(/\u200B/g, '').replace(/\s+/g, ' ').trim();
        return text && (text.includes(expected) || expected.includes(text));
      });
      if (contained.length) return contained.sort((a, b) => (a.textContent || '').length - (b.textContent || '').length)[0];
    }
    // Prefer the smallest visible text block. Attachment cards usually live in
    // a sibling and must not become the question's scroll anchor.
    return candidates.sort((a, b) => (a.textContent || '').length - (b.textContent || '').length)[0];
  }

  function messageRows(scope = document) {
    const candidates = Array.from(scope.querySelectorAll(MESSAGE_SELECTOR)).filter(node => roleFor(node) && !node.closest(EXCLUDED));
    const rows = [];
    for (const marker of candidates) {
      const role = roleFor(marker);
      const target = targetFor(marker);
      if (!target) continue;
      // Prefer a specific author marker inside a turn wrapper. A pair wrapper
      // never suppresses the separate user/assistant bodies it contains.
      const specific = marker.querySelector('[data-message-author-role="' + role + '"]');
      if (!marker.hasAttribute('data-message-author-role') && specific && targetFor(specific)) continue;
      if (candidates.some(other => other !== marker && marker.contains(other) && roleFor(other) !== role && targetFor(other))) continue;
      if (rows.some(row => row.role === role && (row.node === target || row.identityNode.contains(marker)))) continue;
      rows.push({node: target, identityNode: marker, role});
    }
    return rows;
  }

  function commonParent(nodes) {
    let parent = nodes[0]?.parentElement || null;
    while (parent && !nodes.every(node => parent.contains(node))) parent = parent.parentElement;
    return parent;
  }

  function conversationRoot() {
    const rows = messageRows(document);
    const firstMain = document.querySelector('main');
    // Message markers are collected across the document, then constrained to
    // their common region. The first <main> may be only a composer/tool panel.
    let root = rows.length ? commonParent(rows.map(row => row.identityNode)) : null;
    if (root?.closest('#cgmap-root,nav,aside,[role="navigation"]')) root = null;
    if (!root) root = document.body || document.documentElement;
    lastStats = {
      strategy: rows.length ? 'message-region' : 'document-fallback',
      mainRegions: document.querySelectorAll('main,[role="main"]').length,
      visibleMarkers: rows.length,
      markersInFirstMain: rows.filter(row => firstMain?.contains(row.identityNode)).length,
      markersOutsideFirstMain: rows.filter(row => !firstMain?.contains(row.identityNode)).length,
      markersInSelectedRegion: rows.filter(row => root.contains(row.identityNode)).length,
      selectedRegionCharacters: (root.textContent || '').length
    };
    return root;
  }

  globalThis.CGMapPage = Object.freeze({messageSelector: MESSAGE_SELECTOR, bodySelector: BODY_SELECTOR,
    roleFor, visible, bodyFor, messageRows, conversationRoot, stats: () => ({...lastStats})});
})();
