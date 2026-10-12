// ==UserScript==
// @name         Solving Colors - Auto Answer & Submit
// @namespace    local.solving-colors
// @version      1.2.0
// @description  Reads the requested emoji position, identifies its color, and submits automatically.
// @match        *://ecnlmediamarket.com/solving-colors*
// @match        *://www.ecnlmediamarket.com/solving-colors*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  // The first content script marks server error documents so the solver does
  // not start polling a 503 response as if it were a puzzle page.
  if (window.__ecnlServiceUnavailable || !/\/solving-colors(?:\/|$)/i.test(location.pathname)) return;

  const STORAGE_KEY = 'sc-auto-correct-count-v1';
  const WRONG_KEY = 'sc-auto-wrong-count-v1';
  const RELOAD_KEY = 'sc-auto-broken-image-reloads-v1';
  const state = {
    running: false,
    busy: false,
    awaitingResult: false,
    submittedPuzzle: '',
    handledImage: '',
    correct: Number.parseInt(localStorage.getItem(STORAGE_KEY) || '0', 10) || 0,
    wrong: Number.parseInt(localStorage.getItem(WRONG_KEY) || '0', 10) || 0,
    retryTimer: 0,
    brokenImageSince: 0,
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function hardReload() {
    if (typeof chrome !== 'undefined' && chrome.runtime?.id && chrome.runtime.sendMessage) {
      const fallback = window.setTimeout(() => location.reload(), 2500);
      try {
        chrome.runtime.sendMessage({ type: 'ECNL_BYPASS_CACHE_RELOAD' }, () => {
          if (chrome.runtime.lastError) {
            clearTimeout(fallback);
            location.reload();
          }
        });
        return;
      } catch {}
      clearTimeout(fallback);
    }
    location.reload();
  }

  function makeController() {
    const host = document.createElement('div');
    host.id = 'sc-auto-controller';
    host.innerHTML = `
      <div class="sc-title">Solving Colors Auto</div>
      <div class="sc-status"><span class="sc-dot"></span><span data-role="status">Paused</span></div>
      <div class="sc-detail" data-role="detail">Ready</div>
      <div class="sc-count">Correct: <strong data-role="count">${state.correct}</strong> · Wrong: <strong data-role="wrong">${state.wrong}</strong></div>
      <div class="sc-actions">
        <button type="button" data-action="start">Start</button>
        <button type="button" data-action="pause">Pause</button>
        <button type="button" class="sc-reset" data-action="reset">Reset count</button>
      </div>`;

    const style = document.createElement('style');
    style.textContent = `
      #sc-auto-controller{position:fixed;right:18px;bottom:18px;z-index:2147483647;width:250px;
        padding:14px;border:1px solid rgba(255,255,255,.17);border-radius:14px;background:#171a21;
        color:#f4f7fb;box-shadow:0 12px 35px rgba(0,0,0,.38);font:13px/1.35 system-ui,-apple-system,Segoe UI,sans-serif}
      #sc-auto-controller *{box-sizing:border-box}
      #sc-auto-controller .sc-title{font-size:15px;font-weight:750;margin-bottom:8px}
      #sc-auto-controller .sc-status{display:flex;align-items:center;gap:7px;font-weight:650}
      #sc-auto-controller .sc-dot{width:9px;height:9px;border-radius:50%;background:#f0a81e;box-shadow:0 0 0 3px rgba(240,168,30,.15)}
      #sc-auto-controller[data-running="true"] .sc-dot{background:#35c46a;box-shadow:0 0 0 3px rgba(53,196,106,.16)}
      #sc-auto-controller .sc-detail{min-height:34px;margin:7px 0;color:#aeb8c8;word-break:break-word}
      #sc-auto-controller .sc-count{margin-bottom:10px;color:#dce4ef}
      #sc-auto-controller .sc-actions{display:grid;grid-template-columns:1fr 1fr;gap:7px}
      #sc-auto-controller button{border:0;border-radius:8px;padding:8px 10px;color:#fff;background:#2678e5;font-weight:700;cursor:pointer}
      #sc-auto-controller button[data-action="pause"]{background:#596273}
      #sc-auto-controller button.sc-reset{grid-column:1/-1;padding:6px;background:#303642;color:#cbd3df;font-size:11px}
      #sc-auto-controller button:disabled{opacity:.45;cursor:not-allowed}`;

    document.documentElement.append(style, host);
    host.querySelector('[data-action="start"]').addEventListener('click', start);
    host.querySelector('[data-action="pause"]').addEventListener('click', () => pause('Paused by user'));
    host.querySelector('[data-action="reset"]').addEventListener('click', () => {
      state.correct = 0;
      state.wrong = 0;
      localStorage.setItem(STORAGE_KEY, '0');
      localStorage.setItem(WRONG_KEY, '0');
      updateController();
    });
    updateController();
  }

  function updateController(status, detail) {
    const host = document.querySelector('#sc-auto-controller');
    if (!host) return;
    host.dataset.running = String(state.running);
    host.querySelector('[data-role="status"]').textContent = status || (state.running ? 'Running' : 'Paused');
    if (detail !== undefined) host.querySelector('[data-role="detail"]').textContent = detail;
    host.querySelector('[data-role="count"]').textContent = String(state.correct);
    host.querySelector('[data-role="wrong"]').textContent = String(state.wrong);
    host.querySelector('[data-action="start"]').disabled = state.running;
    host.querySelector('[data-action="pause"]').disabled = !state.running;
  }

  function start() {
    if (state.running) return;
    state.running = true;
    state.handledImage = '';
    updateController('Running', 'Waiting for a puzzle...');
    scheduleScan(0);
  }

  function pause(reason = 'Paused') {
    state.running = false;
    state.busy = false;
    clearTimeout(state.retryTimer);
    updateController('Paused', reason);
  }

  function scheduleScan(delay = 250) {
    clearTimeout(state.retryTimer);
    if (!state.running) return;
    state.retryTimer = window.setTimeout(scan, delay);
  }

  function puzzleImage() {
    return [...document.querySelectorAll('#pro_colors_show_colors img')]
      .find((img) => /magic-colors\.php/i.test(img.currentSrc || img.src));
  }

  function reloadBrokenPage() {
    const now = Date.now();
    let history = [];
    try {
      history = JSON.parse(sessionStorage.getItem(RELOAD_KEY) || '[]')
        .filter((time) => Number.isFinite(time) && now - time < 90000);
    } catch (_) {
      history = [];
    }

    if (history.length >= 3) {
      pause('Puzzle image is still broken after 3 reloads. Please check the connection.');
      return;
    }

    history.push(now);
    sessionStorage.setItem(RELOAD_KEY, JSON.stringify(history));
    updateController('Reloading', `Broken puzzle image detected (${history.length}/3). Reloading the whole page...`);
    window.setTimeout(hardReload, 500);
  }

  async function scan() {
    if (!state.running || state.busy || state.awaitingResult) return;
    const img = puzzleImage();
    const input = document.querySelector('#answer_code');
    const button = document.querySelector('#word_login');
    if (!img || !input || !button) return scheduleScan(350);

    if (!img.complete) {
      state.brokenImageSince = 0;
      img.addEventListener('load', () => scheduleScan(50), { once: true });
      img.addEventListener('error', () => scheduleScan(50), { once: true });
      return scheduleScan(500);
    }

    if (!img.naturalWidth || !img.naturalHeight) {
      state.brokenImageSince ||= Date.now();
      const elapsed = Date.now() - state.brokenImageSince;
      updateController('Image error', 'Puzzle image failed to load. Preparing a full-page reload...');
      if (elapsed >= 2500) return reloadBrokenPage();
      return scheduleScan(300);
    }

    state.brokenImageSince = 0;
    sessionStorage.removeItem(RELOAD_KEY);

    const key = `${img.currentSrc || img.src}|${img.naturalWidth}x${img.naturalHeight}`;
    if (key === state.handledImage) return scheduleScan(350);

    state.busy = true;
    try {
      updateController('Reading', 'Detecting the requested emoji...');
      const solution = solveImage(img);
      updateController('Solved', `Emoji ${solution.position}: ${solution.color}`);

      while (state.running && (button.disabled || !isVisible(button))) await sleep(150);
      if (!state.running) return;

      setNativeValue(input, solution.color);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));

      state.handledImage = key;
      state.submittedPuzzle = key;
      state.awaitingResult = true;
      updateController('Submitting', `Emoji ${solution.position}: ${solution.color}`);
      button.click();

      window.setTimeout(() => {
        if (state.awaitingResult && state.submittedPuzzle === key) {
          state.awaitingResult = false;
          state.handledImage = key;
          updateController('Recovering', 'No result received. Reloading to get a fresh puzzle.');
          hardReload();
        }
      }, 15000);
    } catch (error) {
      console.error('[Solving Colors Auto]', error);
      pause(`Could not read puzzle: ${error.message}`);
    } finally {
      state.busy = false;
    }
  }

  function isVisible(element) {
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
  }

  function setNativeValue(input, value) {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    descriptor.set.call(input, value);
  }

  function solveImage(img) {
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(img, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);

    const position = readHighlightedNumber(pixels);
    if (!Number.isInteger(position) || position < 1 || position > 36) {
      throw new Error(`invalid emoji number (${position || 'not found'})`);
    }

    const index = position - 1;
    const row = Math.floor(index / 12);
    const column = index % 12;
    const x = Math.round(canvas.width * (0.0955 + column * 0.07355));
    const y = Math.round(canvas.height * (0.143 + row * 0.165));
    const rgb = sampleCenterColor(pixels, x, y);
    const color = nameColor(rgb);
    return { position, row, column, rgb, color };
  }

  function readHighlightedNumber(imageData) {
    const { width: w, height: h, data } = imageData;
    let left = w, top = h, right = -1, bottom = -1;
    for (let y = Math.floor(h * 0.60); y < Math.floor(h * 0.92); y++) {
      for (let x = 0; x < w; x++) {
        const p = (y * w + x) * 4;
        const r = data[p], g = data[p + 1], b = data[p + 2];
        const highlight = r >= 55 && r <= 155 && g >= 75 && g <= 180 && b >= 100 && b <= 205 && b - r > 12 && g - r > 5;
        if (highlight) {
          left = Math.min(left, x); top = Math.min(top, y);
          right = Math.max(right, x); bottom = Math.max(bottom, y);
        }
      }
    }
    if (right < left || bottom < top || right - left < 15 || bottom - top < 12) {
      throw new Error('highlighted number box not found');
    }

    const padX = Math.max(4, Math.round((right - left) * 0.10));
    const padY = Math.max(3, Math.round((bottom - top) * 0.14));
    const x0 = left + padX, x1 = right - padX;
    const y0 = top + padY, y1 = bottom - padY;
    const mask = [];
    const mw = x1 - x0 + 1, mh = y1 - y0 + 1;
    for (let y = y0; y <= y1; y++) {
      const row = [];
      for (let x = x0; x <= x1; x++) {
        const p = (y * w + x) * 4;
        const r = data[p], g = data[p + 1], b = data[p + 2];
        row.push(Math.min(r, g, b) > 170 && Math.max(r, g, b) - Math.min(r, g, b) < 42 ? 1 : 0);
      }
      mask.push(row);
    }

    const segments = splitGlyphs(mask, mw, mh);
    if (!segments.length || segments.length > 2) throw new Error('number glyphs not recognized');
    return Number.parseInt(segments.map(classifyDigit).join(''), 10);
  }

  function splitGlyphs(mask, width, height) {
    const active = Array(width).fill(false);
    for (let x = 0; x < width; x++) {
      for (let y = 0; y < height; y++) if (mask[y][x]) { active[x] = true; break; }
    }
    const spans = [];
    let start = -1;
    for (let x = 0; x <= width; x++) {
      if (x < width && active[x] && start < 0) start = x;
      if ((x === width || !active[x]) && start >= 0) {
        if (x - start >= 2) spans.push([start, x - 1]);
        start = -1;
      }
    }
    return spans.map(([a, b]) => cropMask(mask, a, 0, b, height - 1));
  }

  function cropMask(mask, left, top, right, bottom) {
    while (top <= bottom && !mask[top].slice(left, right + 1).some(Boolean)) top++;
    while (bottom >= top && !mask[bottom].slice(left, right + 1).some(Boolean)) bottom--;
    return mask.slice(top, bottom + 1).map((row) => row.slice(left, right + 1));
  }

  let digitTemplates;
  function classifyDigit(source) {
    digitTemplates ||= buildDigitTemplates();
    const observed = fitMask(source, 20, 30);
    let bestDigit = '?', bestScore = -1;
    for (const template of digitTemplates) {
      const score = maskScore(observed, template.mask);
      if (score > bestScore) { bestScore = score; bestDigit = template.digit; }
    }
    if (bestScore < 0.61) throw new Error(`low OCR confidence (${bestScore.toFixed(2)})`);
    return bestDigit;
  }

  function buildDigitTemplates() {
    const fonts = ['monospace', 'Consolas', 'Courier New', 'Lucida Console'];
    const templates = [];
    for (const font of fonts) {
      for (let digit = 0; digit <= 9; digit++) {
        const canvas = document.createElement('canvas');
        canvas.width = 54; canvas.height = 52;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        context.fillStyle = '#fff';
        context.font = `30px ${font}`;
        context.textBaseline = 'alphabetic';
        context.fillText(String(digit), 12, 38);
        const image = context.getImageData(0, 0, canvas.width, canvas.height);
        const rows = [];
        for (let y = 0; y < canvas.height; y++) {
          const row = [];
          for (let x = 0; x < canvas.width; x++) row.push(image.data[(y * canvas.width + x) * 4 + 3] > 100 ? 1 : 0);
          rows.push(row);
        }
        const box = boundingBox(rows);
        templates.push({ digit: String(digit), mask: fitMask(cropMask(rows, box.left, box.top, box.right, box.bottom), 20, 30) });
      }
    }
    return templates;
  }

  function boundingBox(mask) {
    let left = Infinity, top = Infinity, right = -1, bottom = -1;
    for (let y = 0; y < mask.length; y++) for (let x = 0; x < mask[y].length; x++) if (mask[y][x]) {
      left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
    }
    return { left, top, right, bottom };
  }

  function fitMask(source, outW, outH) {
    const srcH = source.length, srcW = source[0].length;
    const scale = Math.min((outW - 4) / srcW, (outH - 4) / srcH);
    const drawW = Math.max(1, Math.round(srcW * scale));
    const drawH = Math.max(1, Math.round(srcH * scale));
    const offsetX = Math.floor((outW - drawW) / 2), offsetY = Math.floor((outH - drawH) / 2);
    const output = Array.from({ length: outH }, () => Array(outW).fill(0));
    for (let y = 0; y < drawH; y++) for (let x = 0; x < drawW; x++) {
      output[offsetY + y][offsetX + x] = source[Math.min(srcH - 1, Math.floor(y / scale))][Math.min(srcW - 1, Math.floor(x / scale))];
    }
    return output;
  }

  function maskScore(a, b) {
    let intersection = 0, whiteA = 0, whiteB = 0, equal = 0, total = 0;
    for (let y = 0; y < a.length; y++) for (let x = 0; x < a[y].length; x++) {
      if (a[y][x]) whiteA++;
      if (b[y][x]) whiteB++;
      if (a[y][x] && b[y][x]) intersection++;
      if (a[y][x] === b[y][x]) equal++;
      total++;
    }
    const f1 = (2 * intersection) / Math.max(1, whiteA + whiteB);
    return f1 * 0.72 + (equal / total) * 0.28;
  }

  function sampleCenterColor(imageData, centerX, centerY) {
    const { width, height, data } = imageData;
    const radius = Math.max(2, Math.round(width * 0.004));
    const values = [[], [], []];
    for (let y = centerY - radius; y <= centerY + radius; y++) for (let x = centerX - radius; x <= centerX + radius; x++) {
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const p = (y * width + x) * 4;
      values[0].push(data[p]); values[1].push(data[p + 1]); values[2].push(data[p + 2]);
    }
    return values.map((channel) => channel.sort((a, b) => a - b)[Math.floor(channel.length / 2)]);
  }

  function nameColor([r, g, b]) {
    const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
    if (max < 80) return 'black';
    if (delta < 32) return max > 150 ? 'white' : 'black';

    let hue;
    if (max === r) hue = 60 * (((g - b) / delta) % 6);
    else if (max === g) hue = 60 * ((b - r) / delta + 2);
    else hue = 60 * ((r - g) / delta + 4);
    if (hue < 0) hue += 360;

    if (hue < 13 || hue >= 345) return 'red';
    if (hue < 43) return max < 190 ? 'brown' : 'orange';
    if (hue < 70) return 'yellow';
    if (hue < 170) return 'green';
    if (hue < 260) return 'blue';
    if (hue < 310) return 'purple';
    return 'pink';
  }

  const observer = new MutationObserver((mutations) => {
    if (state.awaitingResult) {
      const resultTouched = mutations.some((mutation) => {
        const target = mutation.target.nodeType === Node.ELEMENT_NODE ? mutation.target : mutation.target.parentElement;
        return target?.closest?.('#result') || [...mutation.addedNodes].some((node) => node.nodeType === Node.ELEMENT_NODE && (node.matches?.('#result') || node.querySelector?.('#result')));
      });
      if (resultTouched) {
        const text = document.querySelector('#result')?.textContent?.replace(/\s+/g, ' ').trim() || '';
        if (/success.*correct answer/i.test(text)) {
          state.awaitingResult = false;
          state.correct++;
          localStorage.setItem(STORAGE_KEY, String(state.correct));
          updateController('Correct', `Accepted. Total correct: ${state.correct}`);
          scheduleScan(500);
        } else if (/incorrect|invalid|wrong/i.test(text)) {
          state.awaitingResult = false;
          state.wrong++;
          localStorage.setItem(WRONG_KEY, String(state.wrong));
          updateController('Continuing', `Wrong answer (${state.wrong} total). Waiting for the next puzzle...`);
          scheduleScan(900);
          const oldKey = state.submittedPuzzle;
          window.setTimeout(() => {
            if (!state.running || state.awaitingResult || state.submittedPuzzle !== oldKey) return;
            const img = puzzleImage();
            const currentKey = img ? `${img.currentSrc || img.src}|${img.naturalWidth}x${img.naturalHeight}` : '';
            if (currentKey === oldKey) {
              updateController('Recovering', 'The next puzzle did not load. Refreshing the page...');
              hardReload();
            }
          }, 6000);
        } else if (/limit reached/i.test(text)) {
          state.awaitingResult = false;
          pause('The site reports its task limit was reached.');
        } else if (/network interruption/i.test(text)) {
          state.awaitingResult = false;
          updateController('Recovering', 'Network interruption. Reloading the page...');
          hardReload();
        }
      }
    } else if (state.running) {
      scheduleScan(120);
    }
  });

  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  makeController();
  start();
})();
