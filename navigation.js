/* Locates virtualized conversation messages through the page's own scroll UI. */
(() => {
  'use strict';

  const MAX_ATTEMPTS = 35;
  const MAX_TIME_MS = 15000;
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

  function scrollable(element) {
    if (!element || !element.isConnected || extentFor(element) <= 2) return false;
    const style = window.getComputedStyle(element);
    return /(auto|scroll|overlay)/.test(style.overflowY) && element.clientHeight > 40;
  }

  function chooseContainer(mounted, findScrollContainer) {
    const target = mounted.length ? mounted[0].target : null;
    if (typeof findScrollContainer === 'function') {
      try {
        const candidate = findScrollContainer(target);
        if (candidate && candidate.isConnected && !isRoot(candidate) && scrollable(candidate)) return candidate;
      } catch (_) { /* The caller may require a mounted target. */ }
    }
    for (let parent = target && target.parentElement; parent; parent = parent.parentElement) {
      if (scrollable(parent)) return parent;
    }
    const main = document.querySelector('main');
    if (main) {
      let best = null;
      let bestScore = -1;
      for (const candidate of [main, ...main.querySelectorAll('*')]) {
        if (!scrollable(candidate)) continue;
        const rect = candidate.getBoundingClientRect();
        if (rect.bottom <= 0 || rect.top >= window.innerHeight || rect.width <= 0) continue;
        const containsMessage = mounted.some(item => candidate.contains(item.target));
        const score = (containsMessage ? 1e12 : 0) + candidate.clientHeight * Math.min(candidate.clientWidth, window.innerWidth);
        if (score > bestScore) {
          best = candidate;
          bestScore = score;
        }
      }
      if (best) return best;
      for (let parent = main.parentElement; parent; parent = parent.parentElement) {
        if (scrollable(parent)) return parent;
      }
    }
    return rootScroller();
  }

  function scrollToPosition(container, top) {
    const safeTop = Math.max(0, Math.min(extentFor(container), Number.isFinite(top) ? top : 0));
    // Instant seeks avoid competing with the site's smooth scrolling or a newer jump.
    container.scrollTo({ top: safeTop, behavior: 'instant' });
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
    let missingHeading = 0;
    let lastMountedTarget = null;

    try {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS && performance.now() - started < MAX_TIME_MS; attempt++) {
        if (cancelled()) return { ok: false, reason: 'cancelled' };
        const mounted = snapshot();
        const found = mounted.find(item => keyFor(item.record) === targetKey);
        const nextContainer = chooseContainer(found ? [found, ...mounted.filter(item => item !== found)] : mounted, findScrollContainer);
        const extent = extentFor(nextContainer);
        if (container !== nextContainer || Math.abs(extent - previousExtent) > Math.max(200, previousExtent * 0.1)) {
          lower = 0;
          upper = extent;
          stagnant = 0;
        } else {
          upper = Math.min(upper, extent);
        }
        container = nextContainer;
        previousExtent = extent;
        const viewport = readViewport(container, viewportFor);
        const margin = Math.min(96, Math.max(48, viewport.height * 0.12));

        if (found) {
          progress('positioning', attempt);
          const headingTarget = matchingHeading(found.target, heading);
          if (!headingTarget && ++missingHeading <= 4) {
            await waitForRender(140, signal);
            continue;
          }
          const destination = headingTarget || found.target;
          lastMountedTarget = found.target;
          const top = container.scrollTop + destination.getBoundingClientRect().top - viewport.top - margin;
          scrollToPosition(container, top);
          await waitForRender(120, signal);
          if (cancelled()) return { ok: false, reason: 'cancelled' };

          // Renderers may recycle the DOM node during a seek. Match the stable ID again.
          const confirmed = snapshot().find(item => keyFor(item.record) === targetKey);
          if (!confirmed) continue;
          const confirmedTarget = matchingHeading(confirmed.target, heading);
          const actualTarget = confirmedTarget || confirmed.target;
          const finalContainer = chooseContainer([confirmed], findScrollContainer);
          const finalViewport = readViewport(finalContainer, viewportFor);
          const finalMargin = Math.min(96, Math.max(48, finalViewport.height * 0.12));
          const correction = actualTarget.getBoundingClientRect().top - finalViewport.top - finalMargin;
          if (Math.abs(correction) > 5) scrollToPosition(finalContainer, finalContainer.scrollTop + correction);
          if (heading !== undefined && heading !== null && !confirmedTarget) {
            return { ok: false, reason: 'heading-not-found', target: confirmed.target, headingFound: false };
          }
          return { ok: true, target: actualTarget, headingFound: heading === undefined || heading === null ? undefined : true };
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
          lower = 0;
          upper = extent;
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
        await waitForRender(attempt < 5 ? 180 : 260, signal);
      }
      if (cancelled()) return { ok: false, reason: 'cancelled' };
      return { ok: false, reason: lastMountedTarget ? 'target-unmounted-during-jump' : 'target-not-rendered' };
    } catch (_) {
      return { ok: false, reason: cancelled() ? 'cancelled' : 'navigation-error' };
    }
  }

  globalThis.CGMapNavigation = Object.freeze({ jump, normalizeHeading });
})();
