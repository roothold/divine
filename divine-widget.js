/**
 * divine-widget.js
 * Drop this into the Uncharted site wherever the "Ask your first question" widget lives.
 * It intercepts the Ask button and redirects to divine.uncharted.ventures with the
 * selected thinker + question pre-loaded into the perspective flow.
 *
 * Usage
 * ─────
 * 1. Include this script on the page that hosts the widget.
 * 2. Make sure each thinker card has:
 *      data-thinker-id="michael"   (or "composite", matching the Divine THINKERS array id)
 * 3. Make sure the question input has:
 *      id="divine-question"
 * 4. Make sure the Ask button has:
 *      id="divine-ask-btn"
 *
 * That's it — the rest is handled automatically.
 */

(function () {
  'use strict';

  const DIVINE_BASE = 'https://divine.uncharted.ventures/';

  // ── State ────────────────────────────────────────────────
  let selectedThinkerId = null;

  // ── Thinker card selection ───────────────────────────────
  document.addEventListener('click', function (e) {
    const card = e.target.closest('[data-thinker-id]');
    if (!card) return;

    // Deselect all, select clicked
    document.querySelectorAll('[data-thinker-id]').forEach(function (el) {
      el.classList.remove('divine-selected');
    });
    card.classList.add('divine-selected');
    selectedThinkerId = card.dataset.thinkerId;

    // Enable the Ask button once a thinker is chosen
    const btn = document.getElementById('divine-ask-btn');
    if (btn) btn.disabled = false;
  });

  // ── Ask button submission ────────────────────────────────
  document.addEventListener('click', function (e) {
    if (e.target.id !== 'divine-ask-btn' && !e.target.closest('#divine-ask-btn')) return;

    const input    = document.getElementById('divine-question');
    const question = input ? input.value.trim() : '';

    if (!question) {
      if (input) input.focus();
      return;
    }

    const url = new URL(DIVINE_BASE);
    if (selectedThinkerId) url.searchParams.set('thinker', selectedThinkerId);
    url.searchParams.set('q', question);

    // Navigate — keeps same tab; swap to window.open(..., '_blank') for new tab
    window.location.href = url.toString();
  });

  // ── ⌘/Ctrl + Enter shortcut inside the textarea ─────────
  document.addEventListener('keydown', function (e) {
    const input = document.getElementById('divine-question');
    if (!input || e.target !== input) return;
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      const btn = document.getElementById('divine-ask-btn');
      if (btn) btn.click();
    }
  });
})();
