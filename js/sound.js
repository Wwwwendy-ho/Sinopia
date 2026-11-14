/* Quiet studio foley. Synthesised locally; no downloads, autoplay, or canvas/gesture work. */
(() => {
  'use strict';
  const KEY = 'sinopia:interaction-sounds';
  let enabled = true, context = null, last = -Infinity;
  const buffers = new Map(), voices = new Set();
  try { enabled = localStorage.getItem(KEY) !== 'off'; } catch (_) { /* session preference */ }
  const toggle = document.getElementById('interaction-sounds');
  if (toggle) toggle.checked = enabled;

  function unlock() {
    if (!enabled || document.hidden) return null;
    try {
      const Audio = window.AudioContext || window.webkitAudioContext;
      if (!Audio) return null;
      if (!context) context = new Audio();
      if (context.state === 'suspended') context.resume().catch(() => {});
      return context;
    } catch (_) { return null; }
  }

  function buffer(kind, ctx) {
    if (buffers.has(kind)) return buffers.get(kind);
    const seconds = { pencil: .115, track: .235, erase: .29, tap: .055, paper: .16 }[kind] || .055;
    const b = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * seconds), ctx.sampleRate);
    const data = b.getChannelData(0);
    // Seeded filtered noise: textured contact rather than a musical beep.
    let seed = 173, brown = 0, low = 0;
    for (let i = 0; i < data.length; i++) {
      seed = (seed * 16807) % 2147483647;
      const white = seed / 1073741823.5 - 1, t = i / data.length;
      brown = (brown + .035 * white) / 1.035;
      low += .14 * (white - low);
      const fade = Math.min(1, t * 35) * Math.pow(1 - t, 1.5);
      let v;
      if (kind === 'pencil') {
        const pressure = .5 + .5 * Math.sin(Math.PI * t);
        v = (white - low) * pressure * (.65 + .35 * Math.sin(t * 130)) * fade;
      } else if (kind === 'track') {
        // A low wooden runner, two tiny stops and a dry rolling rattle.
        const stops = Math.exp(-t * 90) + .6 * Math.exp(-Math.pow((t - .83) * 65, 2));
        v = (brown * 7 + low * .25) * Math.sin(Math.PI * t) * fade + white * stops * .3;
      } else if (kind === 'erase') {
        const brush = Math.pow(Math.sin(t * Math.PI * 3), 2);
        v = (low * 1.5 + brown * 2) * brush * fade;
      } else if (kind === 'paper') {
        v = (white * .35 + brown * 2) * Math.pow(Math.sin(Math.PI * t), 2) * fade;
      } else {
        v = (low + white * .15) * Math.exp(-t * 9) * fade;
      }
      data[i] = v;
    }
    buffers.set(kind, b);
    return b;
  }

  function play(kind = 'tap') {
    const ctx = unlock();
    if (!ctx || ctx.currentTime - last < .045) return;
    last = ctx.currentTime;
    try {
      if (voices.size >= 3) { const oldest = voices.values().next().value; oldest.stop(); voices.delete(oldest); }
      const source = ctx.createBufferSource(), filter = ctx.createBiquadFilter(), gain = ctx.createGain();
      source.buffer = buffer(kind, ctx);
      filter.type = 'bandpass';
      filter.frequency.value = { pencil: 2400, track: 680, erase: 1300, paper: 1800, tap: 950 }[kind] || 950;
      filter.Q.value = .55;
      gain.gain.value = { pencil: .12, track: .15, erase: .17, paper: .1, tap: .15 }[kind] || .12;
      source.connect(filter).connect(gain).connect(ctx.destination);
      voices.add(source);
      source.onended = () => { voices.delete(source); source.disconnect(); filter.disconnect(); gain.disconnect(); };
      source.start();
    } catch (_) { /* sound must never interrupt a tool */ }
  }

  if (toggle) toggle.addEventListener('change', () => {
    enabled = toggle.checked;
    try { localStorage.setItem(KEY, enabled ? 'on' : 'off'); } catch (_) { /* session only */ }
    if (enabled) play('pencil');
    else { voices.forEach(s => { try { s.stop(); } catch (_) {} }); voices.clear(); }
  });

  const byId = { 'btn-fit': 'paper', 'btn-link': 'tap', 'btn-grid': 'pencil', 'btn-gray': 'pencil', 'btn-export': 'paper', 'btn-swap': 'paper' };
  const byAction = { flipH: 'paper', flipV: 'paper', rotate: 'paper', gray: 'pencil', contrast: 'pencil', reset: 'paper', hide: 'tap', prev: 'paper', lineup: 'pencil' };
  document.addEventListener('click', e => {
    if (!e.isTrusted || !enabled) return;
    // Also primes audio before a removal's native confirmation dialog.
    const el = e.target.closest('button, label');
    if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true') return;
    unlock();
    const target = el.htmlFor && document.getElementById(el.htmlFor);
    if (target && target.type === 'radio' && !target.disabled) {
      play(target.name === 'layout' ? 'track' : 'pencil');
      return;
    }
    const kind = byId[el.id] || byAction[el.dataset.action] || (el.dataset.shelf ? 'paper' : null);
    if (kind) play(kind);
  }, true);
  document.addEventListener('keydown', e => {
    if (!e.isTrusted || e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.target.closest('input, textarea, select, button, [contenteditable="true"]') || document.querySelector('dialog[open]')) return;
    const k = e.key.toLowerCase();
    if (['1', '2', '3'].includes(k)) play('track');
    else if (['f', 'm', 'r', 'p', ',', '.', 'o'].includes(k)) play('paper');
    else if (['g', 'v', 'b', 'c', 'd', 't'].includes(k)) play('pencil');
    else if (['l', 'h'].includes(k)) play('tap');
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && context) context.suspend().catch(() => {});
  });
  window.DrawingCompare = window.DrawingCompare || {};
  window.DrawingCompare.sound = { play, get enabled() { return enabled; } };
})();
