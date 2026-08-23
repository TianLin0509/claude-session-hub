'use strict';

function normalizeQuestionSummary(value, maxLength = 72) {
  const limit = Math.max(12, Number(maxLength) || 72);
  const text = String(value || '')
    .replace(/```[\s\S]*?```/g, ' [代码] ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]\s)\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '（空问题）';
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}

function activeQuestionIndexFromTops(tops, anchor, atBottom = false) {
  if (!Array.isArray(tops) || tops.length === 0) return -1;
  if (atBottom) return tops.length - 1;
  let active = 0;
  for (let index = 0; index < tops.length; index += 1) {
    if (Number(tops[index]) <= Number(anchor)) active = index;
    else break;
  }
  return active;
}

function createCardQuestionNavigator(options = {}) {
  const doc = options.document || document;
  const win = options.window || window;
  const overlay = options.overlay || doc.getElementById('msg-overlay');
  const root = options.root || doc.getElementById('card-question-nav');
  const track = root && root.querySelector('.card-question-nav-track');
  const tooltip = root && root.querySelector('.card-question-nav-tooltip');
  const tooltipIndex = tooltip && tooltip.querySelector('.card-question-nav-tooltip-index');
  const tooltipSummary = tooltip && tooltip.querySelector('.card-question-nav-tooltip-summary');
  const getCurrentView = typeof options.getCurrentView === 'function' ? options.getCurrentView : () => 'card';
  const getActiveSessionId = typeof options.getActiveSessionId === 'function' ? options.getActiveSessionId : () => null;
  const getTurnById = typeof options.getTurnById === 'function' ? options.getTurnById : () => null;
  const raf = typeof options.requestAnimationFrame === 'function'
    ? options.requestAnimationFrame
    : (callback) => setTimeout(callback, 0);
  const cancelRaf = typeof options.cancelAnimationFrame === 'function'
    ? options.cancelAnimationFrame
    : clearTimeout;

  let entries = [];
  let activeIndex = -1;
  let refreshFrame = null;
  let scrollFrame = null;
  let observer = null;
  let highlightedCard = null;
  let highlightTimer = null;
  let disposed = false;

  function prefersReducedMotion() {
    try { return !!win.matchMedia?.('(prefers-reduced-motion: reduce)').matches; }
    catch { return false; }
  }

  function hideTooltip() {
    if (tooltip) tooltip.hidden = true;
  }

  function showTooltip(entry, button) {
    if (!tooltip || !entry || !button || !root) return;
    if (tooltipIndex) tooltipIndex.textContent = `问题 ${entry.index + 1}`;
    if (tooltipSummary) tooltipSummary.textContent = entry.summary;
    const rootRect = root.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    const desired = buttonRect.top - rootRect.top + buttonRect.height / 2;
    tooltip.style.top = `${Math.max(10, Math.min(rootRect.height - 10, desired))}px`;
    tooltip.hidden = false;
  }

  function setVisible(visible) {
    if (!root || !overlay) return;
    root.hidden = !visible;
    overlay.classList.toggle('question-nav-visible', visible);
    if (!visible) hideTooltip();
  }

  function keepActiveButtonVisible(button) {
    if (!track || !button) return;
    const top = button.offsetTop;
    const bottom = top + button.offsetHeight;
    if (top < track.scrollTop) track.scrollTop = top;
    else if (bottom > track.scrollTop + track.clientHeight) {
      track.scrollTop = Math.max(0, bottom - track.clientHeight);
    }
  }

  function updateActive({ keepMarkerVisible = true } = {}) {
    if (!overlay || entries.length === 0 || root?.hidden) return -1;
    const overlayRect = overlay.getBoundingClientRect();
    const anchor = overlayRect.top + Math.min(180, overlayRect.height * 0.28);
    const atBottom = overlay.scrollHeight - overlay.scrollTop - overlay.clientHeight < 4;
    const next = activeQuestionIndexFromTops(
      entries.map(entry => entry.card.getBoundingClientRect().top),
      anchor,
      atBottom,
    );
    if (next < 0) return next;
    const changed = activeIndex !== next;
    activeIndex = next;
    entries.forEach((entry, index) => {
      const active = index === activeIndex;
      entry.button.classList.toggle('active', active);
      if (active) entry.button.setAttribute('aria-current', 'true');
      else entry.button.removeAttribute('aria-current');
    });
    if (changed && keepMarkerVisible) keepActiveButtonVisible(entries[activeIndex]?.button);
    return activeIndex;
  }

  function flashCard(card) {
    if (!card) return;
    if (highlightTimer) clearTimeout(highlightTimer);
    if (highlightedCard && highlightedCard !== card) highlightedCard.classList.remove('question-jump-highlight');
    highlightedCard = card;
    card.classList.remove('question-jump-highlight');
    // Restart the short visual confirmation even when clicking the same marker.
    void card.offsetWidth;
    card.classList.add('question-jump-highlight');
    highlightTimer = setTimeout(() => {
      card.classList.remove('question-jump-highlight');
      if (highlightedCard === card) highlightedCard = null;
      highlightTimer = null;
    }, prefersReducedMotion() ? 120 : 700);
  }

  function scrollToQuestion(index, { focusMarker = false } = {}) {
    const entry = entries[index];
    if (!entry || !overlay) return false;
    const overlayRect = overlay.getBoundingClientRect();
    const cardRect = entry.card.getBoundingClientRect();
    const targetTop = Math.max(0, overlay.scrollTop + cardRect.top - overlayRect.top - 10);
    const behavior = prefersReducedMotion() ? 'auto' : 'smooth';
    try { overlay.scrollTo({ top: targetTop, behavior }); }
    catch { overlay.scrollTop = targetTop; }
    activeIndex = index;
    entries.forEach((item, itemIndex) => {
      const active = itemIndex === index;
      item.button.classList.toggle('active', active);
      if (active) item.button.setAttribute('aria-current', 'true');
      else item.button.removeAttribute('aria-current');
    });
    keepActiveButtonVisible(entry.button);
    flashCard(entry.card);
    if (focusMarker) entry.button.focus();
    return true;
  }

  function markerKeydown(event, index) {
    let target = null;
    if (event.key === 'ArrowUp') target = Math.max(0, index - 1);
    else if (event.key === 'ArrowDown') target = Math.min(entries.length - 1, index + 1);
    else if (event.key === 'Home') target = 0;
    else if (event.key === 'End') target = entries.length - 1;
    if (target === null || target === index) return;
    event.preventDefault();
    scrollToQuestion(target, { focusMarker: true });
  }

  function questionTextForCard(card) {
    const turnId = card.dataset.turnId || '';
    const turn = turnId ? getTurnById(turnId) : null;
    if (turn && typeof turn.text === 'string') return turn.text;
    return card.querySelector('.turn-body')?.innerText || '';
  }

  function refresh() {
    if (disposed || !root || !track || !overlay) return { count: 0, activeIndex: -1, visible: false };
    refreshFrame = null;
    const sessionId = String(getActiveSessionId() || '');
    const cardViewVisible = getCurrentView() === 'card' && !!sessionId && !overlay.classList.contains('hidden');
    const cards = cardViewVisible
      ? Array.from(overlay.querySelectorAll(':scope > .turn-card.user')).filter(card => (
        !card.dataset.sessionId || card.dataset.sessionId === sessionId
      ))
      : [];

    track.replaceChildren();
    entries = [];
    activeIndex = -1;
    if (cards.length < 2) {
      setVisible(false);
      return { count: cards.length, activeIndex, visible: false };
    }

    const fragment = doc.createDocumentFragment();
    cards.forEach((card, index) => {
      const summary = normalizeQuestionSummary(questionTextForCard(card));
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'card-question-nav-item';
      button.dataset.questionIndex = String(index);
      button.setAttribute('aria-label', `跳转到问题 ${index + 1}：${summary}`);
      button.title = `问题 ${index + 1}：${summary}`;
      const label = doc.createElement('span');
      label.className = 'card-question-nav-label';
      label.textContent = '你';
      button.appendChild(label);
      const entry = { index, card, button, summary };
      button.addEventListener('click', () => scrollToQuestion(index));
      button.addEventListener('keydown', event => markerKeydown(event, index));
      button.addEventListener('mouseenter', () => showTooltip(entry, button));
      button.addEventListener('mouseleave', hideTooltip);
      button.addEventListener('focus', () => showTooltip(entry, button));
      button.addEventListener('blur', hideTooltip);
      entries.push(entry);
      fragment.appendChild(button);
    });
    track.appendChild(fragment);
    setVisible(true);
    updateActive({ keepMarkerVisible: false });
    return { count: entries.length, activeIndex, visible: true };
  }

  function scheduleRefresh() {
    if (disposed || refreshFrame !== null) return;
    refreshFrame = raf(refresh);
  }

  function onScroll() {
    if (disposed || scrollFrame !== null) return;
    scrollFrame = raf(() => {
      scrollFrame = null;
      updateActive();
    });
  }

  function init() {
    if (!root || !track || !overlay) return false;
    overlay.addEventListener('scroll', onScroll, { passive: true });
    if (typeof win.MutationObserver === 'function') {
      observer = new win.MutationObserver(scheduleRefresh);
      observer.observe(overlay, { childList: true });
    }
    scheduleRefresh();
    return true;
  }

  function dispose() {
    disposed = true;
    if (refreshFrame !== null) cancelRaf(refreshFrame);
    if (scrollFrame !== null) cancelRaf(scrollFrame);
    if (highlightTimer) clearTimeout(highlightTimer);
    observer?.disconnect();
    overlay?.removeEventListener('scroll', onScroll);
    if (highlightedCard) highlightedCard.classList.remove('question-jump-highlight');
    entries = [];
    setVisible(false);
  }

  return {
    dispose,
    init,
    refresh,
    scheduleRefresh,
    scrollToQuestion,
    updateActive,
    getState: () => ({
      count: entries.length,
      activeIndex,
      visible: !!root && !root.hidden,
      summaries: entries.map(entry => entry.summary),
    }),
  };
}

module.exports = {
  activeQuestionIndexFromTops,
  createCardQuestionNavigator,
  normalizeQuestionSummary,
};
