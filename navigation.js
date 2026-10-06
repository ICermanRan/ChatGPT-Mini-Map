/* Locates virtualized conversation messages through the page's own scroll UI. */
(() => {
  'use strict';

  const MAX_ATTEMPTS = 35;
  const MAX_TIME_MS = 15000;
  const ALIGN_TIME_MS = 2600;
  const STABLE_TIME_MS = 650;
  const ALIGN_TOLERANCE = 8;
  let operation = 0;

  function normalizeHeading(value) {
    return String(value || '')
      .normalize('NFKC')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/^\s*#{1,6}\s+/, '')
      .replace(/\s+#+\s*$/, '')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/<[^>]*>/g, '')
      .replace(/[`*_~]/g, '')
      .replace(/\\([\\`*_{}\[\]()#+.!>-])/g, '$1')
      .replace(/\s+/g, ' ')
      .trim()
      .toLocaleLowerCase();
  }

  function keyFor(record) {
    if (!record || typeof record !== 'object') return null;
    if (record.id !== undefined && record.id !== null) return `id:${String(record.id)}`;
    if (record.nodeId !== undefined && record.nodeId !== null) return `node:${String(record.nodeId)}`;
    return null;
  }

  function rootScroller() {
    return document.scrollingElement || document.documentElement;
  }

  function isRoot(container) {
    return container === document.body || container === document.documentElement || container === document.scrollingElement;
  }

  function extentFor(container) {
    return Math.max(0, container.scrollHeight - container.clientHeight);
  }

  function scrollBounds(container) {
    const extent = extentFor(container);
    // ChatGPT's virtual transcript can use a reversed/flex scroll model. In
    // that model native scrollIntoView legitimately produces a negative
    // scrollTop; clamping it to zero moves the transcript back to the wrong
    // window.
    const current = Number(container?.scrollTop) || 0;
    return current < -2 ? {min: -extent, max: 0} : {min: 0, max: extent};
  }

  function debugContainer(container, mounted, main) {
    if (!container) return null;
    const rect = container.getBoundingClientRect?.();
    const style = window.getComputedStyle(container);
    return {
      tag: container.tagName || null, isRoot: isRoot(container), isMain: container === main,
      overflowY: style.overflowY, position: style.position,
      scrollTop: Math.round(Number(container.scrollTop) || 0),
      scrollHeight: Math.round(Number(container.scrollHeight) || 0),
      clientHeight: Math.round(Number(container.clientHeight) || 0),
      clientWidth: Math.round(Number(container.clientWidth) || 0),
      rect: rect ? {top: Math.round(rect.top), height: Math.round(rect.height), width: Math.round(rect.width)} : null,
      coverage: mounted.filter(item => container.contains(item.target)).length
    };
  }

  function defaultViewport(container) {
    if (isRoot(container)) return { top: 0, height: window.innerHeight };
    const rect = container.getBoundingClientRect();
    const top = Math.max(0, rect.top + container.clientTop);
    return { top, height: Math.max(1, Math.min(window.innerHeight, rect.bottom) - top) };
  }

  function readViewport(container, viewportFor) {
    if (typeof viewportFor === 'function') {
      try {
        const value = viewportFor(container);
        if (value && Number.isFinite(value.top) && Number.isFinite(value.height) && value.height > 0) return value;
      } catch (_) { /* Fall back when a page wrapper was just replaced. */ }
    }
    return defaultViewport(container);
  }

  function containerScore(candidate, mounted, main) {
    if (!candidate || !candidate.isConnected || isRoot(candidate) || extentFor(candidate) <= 2) return -1;
    // A message's code block, text widget, or nested body is never the conversation viewport.
    if (candidate.closest('pre, code, textarea, [contenteditable="true"], [role="textbox"], .markdown, .prose, [data-message-author-role], [data-message-id], [data-testid^="conversation-turn-"]')) return -1;
    if (candidate.closest('[hidden], [aria-hidden="true"], [inert]')) return -1;
    if (mounted.some(item => item.target === candidate || item.target.contains(candidate))) return -1;
    const primary = mounted[0]?.target;
    if (primary && !candidate.contains(primary)) return -1;
    const style = window.getComputedStyle(candidate);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return -1;
    // Some layouts use overflow:hidden for the programmatically scrolled conversation viewport.
    if (!/(auto|scroll|overlay|hidden)/.test(style.overflowY)) return -1;
    const rect = candidate.getBoundingClientRect();
    const visibleHeight = Math.min(window.innerHeight, rect.bottom) - Math.max(0, rect.top);
    if (!candidate.getClientRects().length || candidate.clientHeight <= 40 || visibleHeight <= 40 || rect.width <= 80) return -1;
    const coverage = mounted.filter(item => candidate.contains(item.target)).length;
    if (style.overflowY === 'hidden' && coverage < 2 && candidate !== main && !(coverage && visibleHeight >= Math.min(240, window.innerHeight * 0.45))) return -1;
    const rangeWeight = Math.min(1, extentFor(candidate) / Math.max(1, candidate.clientHeight));
    return coverage * 1e9 + rangeWeight * 1e7 + visibleHeight * 1000 + Math.min(rect.width, window.innerWidth);
  }

  function chooseContainer(mounted, findScrollContainer, blocked = null) {
    const target = mounted.length ? mounted[0].target : null;
    const main = document.querySelector('main');
    const candidates = new Set();
    if (typeof findScrollContainer === 'function') {
      try { candidates.add(findScrollContainer(target, mounted)); }
      catch (_) { /* The caller may require a mounted target. */ }
    }
    for (let parent = target && target.parentElement; parent; parent = parent.parentElement) candidates.add(parent);
    if (main) {
      candidates.add(main);
      for (let parent = main.parentElement; parent; parent = parent.parentElement) candidates.add(parent);
    }
    const select = () => {
      let best = null;
      let bestScore = -1;
      for (const candidate of candidates) {
        if (blocked?.has(candidate)) continue;
        const score = containerScore(candidate, mounted, main);
        if (score > bestScore) { best = candidate; bestScore = score; }
      }
      return best;
    };
    let best = select();
    if (!best && main) {
      for (const candidate of main.querySelectorAll('*')) candidates.add(candidate);
      best = select();
    }
    return best || rootScroller();
  }
  function scrollToPosition(container, top) {
    const bounds = scrollBounds(container);
    const safeTop = Math.max(bounds.min, Math.min(bounds.max, Number.isFinite(top) ? top : 0));
    // Instant seeks avoid competing with the site's smooth scrolling or a newer jump.
    try { container.scrollTo({ top: safeTop, behavior: 'instant' }); }
    catch (_) { try { container.scrollTo(0, safeTop); } catch (_) {} }
    // Some ChatGPT rollout containers expose scrollTo but ignore the options
    // object while their virtual list is mounting. Direct assignment provides
    // a second synchronous path before the next render sample.
    if (Math.abs((Number(container.scrollTop) || 0) - safeTop) > 2) {
      try { container.scrollTop = safeTop; } catch (_) {}
    }
    return safeTop;
  }

  function matchingHeading(target, heading) {
    if (heading === undefined || heading === null) return target;
    const text = typeof heading === 'string' ? heading : heading.text ?? heading.label ?? heading.title ?? '';
    const normalized = normalizeHeading(text);
    if (!normalized) return null;
    const level = typeof heading === 'object' && Number(heading.level);
    const candidates = Array.from(target.querySelectorAll('h1, h2, h3')).filter(node => {
      return (!level || Number(node.tagName.slice(1)) === level) && !node.closest('pre, code, [hidden], [aria-hidden="true"]');
    });
    let matches = candidates.filter(node => normalizeHeading(node.innerText || node.textContent) === normalized);
    if (!matches.length) {
      // Inline code and rendered math can introduce harmless whitespace changes.
      const compact = normalized.replace(/\s/g, '');
      matches = candidates.filter(node => normalizeHeading(node.innerText || node.textContent).replace(/\s/g, '') === compact);
    }
    const duplicateIndex = typeof heading === 'object' && Number.isInteger(heading.index) && heading.index >= 0 ? heading.index : 0;
    return matches[duplicateIndex] || null;
  }

  function waitForRender(milliseconds, signal) {
    return new Promise(resolve => {
      let timer;
      const finish = () => {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', finish);
        resolve();
      };
      if (signal && signal.aborted) return resolve();
      if (signal) signal.addEventListener('abort', finish, { once: true });
      timer = window.setTimeout(finish, milliseconds);
    });
  }

  function median(values) {
    const sorted = values.filter(value => Number.isFinite(value) && value > 1).sort((a, b) => a - b);
    return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
  }

  async function jump(options = {}) {
    const run = ++operation;
    const started = performance.now();
    const route = location.href;
    const main = globalThis.CGMapPage?.conversationRoot?.() || document.querySelector('main') || document.body;
    const { record, heading, getMounted, findScrollContainer, viewportFor, signal, onProgress } = options;
    const targetKey = keyFor(record);
    const records = Array.isArray(options.records) ? options.records : [];
    if (!targetKey || typeof getMounted !== 'function') return { ok: false, reason: 'invalid-target' };

    const ordered = records.map((item, index) => ({ item, index })).sort((a, b) => {
      const aOrder = Number.isFinite(a.item.order) ? a.item.order : a.index;
      const bOrder = Number.isFinite(b.item.order) ? b.item.order : b.index;
      return aOrder - bOrder || a.index - b.index;
    });
    const indices = new Map();
    ordered.forEach(({ item }, index) => {
      const key = keyFor(item);
      if (key && !indices.has(key)) indices.set(key, index);
    });
    const targetIndex = indices.get(targetKey);
    if (targetIndex === undefined) return { ok: false, reason: 'target-not-in-conversation' };

    const cancelled = () => run !== operation || (signal && signal.aborted) || location.href !== route;
    const snapshot = () => {
      let current;
      try { current = getMounted(); } catch (_) { return []; }
      if (!Array.isArray(current)) return [];
      const unique = new Set();
      return current.filter(item => {
        const key = item && keyFor(item.record);
        if (!key || unique.has(key) || !indices.has(key) || !item.target || !item.target.isConnected || typeof item.target.getBoundingClientRect !== 'function') return false;
        unique.add(key);
        return true;
      }).map(item => ({ ...item, index: indices.get(keyFor(item.record)) })).sort((a, b) => a.index - b.index);
    };
    const progress = (phase, attempt) => {
      if (typeof onProgress !== 'function') return;
      try {
        onProgress({ phase, attempt, maxAttempts: MAX_ATTEMPTS, message: phase === 'positioning' ? '正在定位消息…' : `正在查找第 ${targetIndex + 1} 条消息…` });
      } catch (_) { /* A status UI must not interrupt navigation. */ }
    };

    let container = null;
    let lower = 0;
    let upper = Infinity;
    let previousExtent = 0;
    let previousTop = NaN;
    let stagnant = 0;
    let alignmentStarted = 0;
    let alignmentCorrections = 0;
    let lastMountedTarget = null;
    let hasAnchors = false;
    let nativeScrollAttempted = false;
    const trace = [];
    const blockedContainers = new WeakSet();
    const debugState = () => ({targetIndex, recordCount: ordered.length, trace: trace.slice(-100)});
    const traceStep = step => { if (trace.length < 100) trace.push(step); };

    async function alignTarget(attempt) {
      if (!alignmentStarted) alignmentStarted = performance.now();
      const deadline = Math.min(started + MAX_TIME_MS, alignmentStarted + ALIGN_TIME_MS);
      let stableSince = 0;
      let stableSamples = 0;
      let previous = null;
      let missingHeading = 0;
      while (performance.now() < deadline) {
        if (cancelled()) return { ok: false, reason: 'cancelled' };
        const mounted = snapshot();
        const found = mounted.find(item => keyFor(item.record) === targetKey);
        if (!found) return { ok: false, retry: true };
        const headingTarget = matchingHeading(found.target, heading);
        if (!headingTarget && ++missingHeading <= 4) {
          await waitForRender(140, signal);
          continue;
        }
        const destination = headingTarget || found.target;
        lastMountedTarget = found.target;
        const currentContainer = chooseContainer([found, ...mounted.filter(item => item !== found)], findScrollContainer, blockedContainers);
        const viewport = readViewport(currentContainer, viewportFor);
        const margin = Math.min(96, Math.max(48, viewport.height * 0.12));
        const rect = destination.getBoundingClientRect();
        const top = currentContainer.scrollTop;
        const extent = extentFor(currentContainer);
        if (!isRoot(currentContainer) && top <= 2 && rect.top < viewport.top - Math.max(500, viewport.height * 2)) {
          if (!nativeScrollAttempted) {
            nativeScrollAttempted = true;
            traceStep({phase: 'native-scroll-into-view', attempt,
              anchorTop: Math.round(rect.top), viewportTop: Math.round(viewport.top),
              container: debugContainer(currentContainer, mounted, main)});
            try { destination.scrollIntoView({block: 'center', inline: 'nearest', behavior: 'instant'}); }
            catch (_) { try { destination.scrollIntoView(); } catch (_) {} }
            await waitForRender(180, signal);
            return {ok: false, retry: true};
          }
          blockedContainers.add(currentContainer);
          traceStep({phase: 'container-mismatch-aligned-target', attempt,
            anchorTop: Math.round(rect.top), viewportTop: Math.round(viewport.top),
            container: debugContainer(currentContainer, mounted, main)});
          return {ok: false, retry: true};
        }
        const delta = rect.top - viewport.top - margin;
        const bounds = scrollBounds(currentContainer);
        const requested = Math.max(bounds.min, Math.min(bounds.max, top + delta));
        const anchorVisible = rect.top >= viewport.top - ALIGN_TOLERANCE && rect.top < viewport.top + viewport.height - Math.min(24, viewport.height * 0.1);
        const limitedByEdge = Math.abs(requested - top) <= 2 && ((top <= bounds.min + 2 && delta < 0) || (top >= bounds.max - 2 && delta > 0));
        const aligned = Math.abs(delta) <= ALIGN_TOLERANCE || (limitedByEdge && anchorVisible);
        const unchanged = previous && previous.container === currentContainer && Math.abs(previous.scrollTop - top) <= 3 && Math.abs(previous.anchorTop - rect.top) <= 3;
        traceStep({phase: 'positioning', attempt, mounted: mounted.length, found: true, aligned, anchorVisible,
          top: Math.round(top), extent: Math.round(extent), anchorTop: Math.round(rect.top),
          viewportTop: Math.round(viewport.top), viewportHeight: Math.round(viewport.height),
          delta: Math.round(delta), requested: Math.round(requested), unchanged: !!unchanged,
          corrections: alignmentCorrections, container: debugContainer(currentContainer, mounted, main)});
        progress('positioning', attempt);
        if (aligned && anchorVisible) {
          if (!stableSince || !unchanged) {
            stableSince = performance.now();
            stableSamples = 1;
          } else stableSamples++;
          // Do not declare success immediately after a write: ChatGPT can restore
          // its previous bottom position or remeasure virtual rows a little later.
          if (stableSamples >= 4 && performance.now() - stableSince >= STABLE_TIME_MS) {
            if (cancelled()) return { ok: false, reason: 'cancelled' };
            if (heading !== undefined && heading !== null && !headingTarget) {
              return { ok: false, reason: 'heading-not-found', target: found.target, headingFound: false };
            }
            return { ok: true, target: destination, headingFound: heading === undefined || heading === null ? undefined : true, debug: debugState() };
          }
        } else {
          stableSince = 0;
          stableSamples = 0;
          if (alignmentCorrections >= 6) return { ok: false, reason: 'position-not-stable', debug: debugState() };
          if (Math.abs(requested - top) > 2) {
            if (cancelled()) return { ok: false, reason: 'cancelled' };
            scrollToPosition(currentContainer, requested);
            alignmentCorrections++;
          }
        }
        previous = { container: currentContainer, scrollTop: top, anchorTop: rect.top };
        await waitForRender(140, signal);
      }
      return { ok: false, reason: cancelled() ? 'cancelled' : 'position-not-stable', debug: debugState() };
    }

    try {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS && performance.now() - started < MAX_TIME_MS; attempt++) {
        if (cancelled()) return { ok: false, reason: 'cancelled' };
        const mounted = snapshot();
        if (mounted.length) hasAnchors = true;
        if (!hasAnchors) {
          traceStep({phase: 'no-anchors', attempt, mounted: mounted.length});
          // Without a single verified message, proportional scrolling is guesswork.
          // Briefly allow initial rendering, then stop without moving the page.
          if (attempt >= 7) return { ok: false, reason: 'page-structure-not-recognized', debug: debugState() };
          await waitForRender(180, signal);
          continue;
        }
        const found = mounted.find(item => keyFor(item.record) === targetKey);
        const nextContainer = chooseContainer(found ? [found, ...mounted.filter(item => item !== found)] : mounted, findScrollContainer, blockedContainers);
        const extent = extentFor(nextContainer);
        traceStep({phase: 'seeking', attempt, mounted: mounted.length, found: !!found,
          top: Math.round(Number(nextContainer.scrollTop) || 0), extent: Math.round(extent),
          targetIndex, container: debugContainer(nextContainer, mounted, main)});
        if (container !== nextContainer || Math.abs(extent - previousExtent) > Math.max(200, previousExtent * 0.1)) {
          const bounds = scrollBounds(nextContainer);
          lower = bounds.min;
          upper = bounds.max;
          stagnant = 0;
        } else {
          upper = Math.min(upper, extent);
        }
        container = nextContainer;
        previousExtent = extent;
        const viewport = readViewport(container, viewportFor);
        const margin = Math.min(96, Math.max(48, viewport.height * 0.12));

        // A virtual content wrapper can report a large scrollHeight while its
        // scrollTop stays at zero and its mounted rows are already thousands
        // of pixels above the viewport. It cannot control the conversation;
        // blacklist it and try the parent/page scroller on the next attempt.
        if (!found && !isRoot(container) && Number(container.scrollTop) <= 2 && mounted.length) {
          const firstAbsolute = mounted.reduce((minimum, item) => Math.min(minimum, item.target.getBoundingClientRect().top - viewport.top), Infinity);
          if (firstAbsolute < -Math.max(500, viewport.height * 2)) {
            if (!found && !nativeScrollAttempted) {
              nativeScrollAttempted = true;
              const nearest = mounted.reduce((best, item) => !best || Math.abs(item.index - targetIndex) < Math.abs(best.index - targetIndex) ? item : best, null);
              traceStep({phase: 'native-scroll-nearest-mounted', attempt, nearestIndex: nearest?.index ?? null,
                firstAbsolute: Math.round(firstAbsolute), container: debugContainer(container, mounted, main)});
              try { nearest?.target.scrollIntoView({block: 'center', inline: 'nearest', behavior: 'instant'}); }
              catch (_) { try { nearest?.target.scrollIntoView(); } catch (_) {} }
              await waitForRender(180, signal);
              continue;
            }
            blockedContainers.add(container);
            traceStep({phase: 'container-mismatch', attempt, firstAbsolute: Math.round(firstAbsolute), container: debugContainer(container, mounted, main)});
            container = null;
            previousExtent = 0;
            lower = 0;
            upper = Infinity;
            await waitForRender(20, signal);
            continue;
          }
        }

        if (alignmentStarted && performance.now() - alignmentStarted >= ALIGN_TIME_MS) return { ok: false, reason: 'position-not-stable' };
        if (found) {
          const result = await alignTarget(attempt);
          if (!result.retry) return result;
          await waitForRender(100, signal);
          continue;
        }
        progress('seeking', attempt);
        if (extent <= 2) {
          await waitForRender(220, signal);
          continue;
        }
        const top = container.scrollTop;
        const before = mounted.filter(item => item.index < targetIndex);
        const after = mounted.filter(item => item.index > targetIndex);
        let direction = 0;
        if (mounted.length && !after.length) {
          direction = 1;
          lower = Math.max(lower, top);
        } else if (mounted.length && !before.length) {
          direction = -1;
          upper = Math.min(upper, top);
        }
        if (upper < lower) {
          const bounds = scrollBounds(container);
          lower = bounds.min;
          upper = bounds.max;
        }

        const geometry = mounted.map(item => ({ ...item, absoluteTop: top + item.target.getBoundingClientRect().top - viewport.top }));
        const heights = [];
        for (let index = 1; index < geometry.length; index++) {
          const prior = geometry[index - 1];
          const current = geometry[index];
          heights.push((current.absoluteTop - prior.absoluteTop) / (current.index - prior.index));
        }
        const averageHeight = Math.max(24, Math.min(20000, median(heights) || container.scrollHeight / Math.max(1, ordered.length)));
        const nearest = geometry.reduce((best, item) => !best || Math.abs(item.index - targetIndex) < Math.abs(best.index - targetIndex) ? item : best, null);
        let estimate = nearest
          ? nearest.absoluteTop + (targetIndex - nearest.index) * averageHeight - margin
          : (targetIndex / Math.max(1, ordered.length - 1)) * extent;

        if (!Number.isFinite(estimate) || estimate < lower || estimate > upper) estimate = (lower + upper) / 2;
        const minimumStep = Math.max(60, viewport.height * 0.35);
        if (direction > 0 && estimate < top + minimumStep) estimate = Math.min(upper, top + Math.max(minimumStep, (upper - top) / 2));
        if (direction < 0 && estimate > top - minimumStep) estimate = Math.max(lower, top - Math.max(minimumStep, (top - lower) / 2));

        if (Number.isFinite(previousTop) && Math.abs(top - previousTop) < 3) stagnant++;
        else stagnant = 0;
        previousTop = top;
        if (stagnant >= 2) {
          // A message between mounted neighbors may still be arriving. Revisit its
          // local window rather than treating a nearby message as a successful hit.
          const wiggle = Math.min(viewport.height * 0.6, 420) * (stagnant % 2 ? -1 : 1);
          estimate = Math.max(lower, Math.min(upper, estimate + (direction || 1) * wiggle));
        }
        scrollToPosition(container, estimate);
        traceStep({phase: 'seek-write', attempt, estimate: Math.round(estimate),
          afterTop: Math.round(Number(container.scrollTop) || 0), extent: Math.round(extent),
          container: debugContainer(container, mounted, main)});
        await waitForRender(attempt < 5 ? 180 : 260, signal);
      }
      if (cancelled()) return { ok: false, reason: 'cancelled' };
      return { ok: false, reason: lastMountedTarget ? 'target-unmounted-during-jump' : 'target-not-rendered', debug: debugState() };
    } catch (_) {
      return { ok: false, reason: cancelled() ? 'cancelled' : 'navigation-error', debug: debugState() };
    }
  }

  function findScrollContainer(target, confirmed) {
    const main = globalThis.CGMapPage?.conversationRoot?.() || document.querySelector('main') || document.body;
    const pageRows = globalThis.CGMapPage?.messageRows?.(main) || [];
    const nodes = [target, ...(Array.isArray(confirmed)
      ? confirmed.map(item => item.target)
      : pageRows.map(row => row.node))];
    const seen = new Set();
    const mounted = [];
    for (const node of nodes) {
      if (!node || !node.isConnected || seen.has(node) || node.closest('[hidden], [aria-hidden="true"], [inert]') || !node.getClientRects().length) continue;
      const style = window.getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') continue;
      seen.add(node);
      mounted.push({ target: node });
    }
    // This public helper has no callback into content.js, avoiding resolver recursion.
    return chooseContainer(mounted, null);
  }

  globalThis.CGMapNavigation = Object.freeze({ jump, normalizeHeading, findScrollContainer });
})();
