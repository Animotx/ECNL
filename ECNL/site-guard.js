(() => {
  'use strict';

  const RETRY_KEY = 'ecnl-503-retry-state-v1';
  const RESUME_GAME_KEY = 'ecnl-resume-game-after-login-v1';
  const LOGIN_RETRIES_KEY = 'ecnl-login-navigation-retries-v1';
  const MAX_LOGIN_RETRIES = 3;
  const bodyText = () => document.body?.innerText || '';
  const isServiceUnavailable = () => {
    const text = `${document.title || ''}\n${bodyText()}`;
    return /\b503\b.{0,80}service unavailable|service unavailable|temporarily unable to service your request/i.test(text);
  };

  function hardReload() {
    if (typeof chrome !== 'undefined' && chrome.runtime?.id && chrome.runtime.sendMessage) {
      const fallback = window.setTimeout(() => location.reload(), 5000);
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

  function updateRecoveryCard(text) {
    let card = document.querySelector('#ecnl-503-recovery');
    if (!card) {
      card = document.createElement('div');
      card.id = 'ecnl-503-recovery';
      card.style.cssText = 'position:fixed!important;right:18px!important;bottom:18px!important;z-index:2147483647!important;background:#18202b!important;color:#f4f7fb!important;border:1px solid #485568!important;border-radius:12px!important;padding:14px 16px!important;max-width:340px!important;box-shadow:0 12px 35px #0008!important;font:13px/1.45 system-ui,sans-serif!important;pointer-events:none!important';
      document.documentElement.append(card);
    }
    card.textContent = text;
  }

  function recover503() {
    window.__ecnlServiceUnavailable = true;
    let saved;
    try { saved = JSON.parse(sessionStorage.getItem(RETRY_KEY) || 'null'); } catch {}
    const now = Date.now();
    if (!saved || !Number.isFinite(saved.retryAt) || saved.retryAt <= now) {
      const count = Math.max(0, Number(saved?.count) || 0);
      const waitMs = Math.min(300000, 30000 * (2 ** Math.min(count, 4)));
      saved = { count: count + 1, retryAt: now + waitMs };
      try { sessionStorage.setItem(RETRY_KEY, JSON.stringify(saved)); } catch {}
    }

    const remaining = Math.max(0, saved.retryAt - Date.now());
    updateRecoveryCard(`ECNL server is unavailable. Retrying in ${Math.ceil(remaining / 1000)} seconds. Wait increases between retries.`);
    window.setTimeout(() => {
      if (isServiceUnavailable()) hardReload();
    }, remaining);
    const ticker = window.setInterval(() => {
      if (!isServiceUnavailable()) {
        clearInterval(ticker);
        return;
      }
      const left = Math.max(0, saved.retryAt - Date.now());
      updateRecoveryCard(left ? `ECNL server is unavailable. Retrying in ${Math.ceil(left / 1000)} seconds. Wait increases between retries.` : 'ECNL server is unavailable. Retrying now…');
    }, 1000);
  }

  function findLoginButton() {
    const form = document.querySelector('#loginForm');
    const button = form?.querySelector('#loginBtn') || document.querySelector('#loginBtn');
    if (!button || button.disabled || !button.isConnected) return null;
    const visible = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
    if (!visible(button)) return null;
    const username = form?.querySelector('#usernametext, input[autocomplete="username"]') || document.querySelector('#usernametext');
    return { button, form, username };
  }

  function refreshTrailingOne(username) {
    // Only touch the exact saved username the user specified. This keeps the
    // helper from modifying a different account if Chrome autofills another one.
    if (!username || !username.isConnected || username.value !== 'Nainai01') return false;
    username.click();
    username.focus();
    const end = username.value.length;
    const emitInput = (inputType, data) => {
      let event;
      try { event = new InputEvent('input', { bubbles: true, inputType, data }); }
      catch { event = new Event('input', { bubbles: true }); }
      username.dispatchEvent(event);
    };

    // Remove the final 1, then retype it so the site's input handler sees both edits.
    username.setRangeText('', end - 1, end, 'end');
    emitInput('deleteContentBackward', null);
    const insertionPoint = username.value.length;
    username.setRangeText('1', insertionPoint, insertionPoint, 'end');
    emitInput('insertText', '1');
    username.dispatchEvent(new Event('change', { bubbles: true }));
    return username.value === 'Nainai01';
  }

  function loginErrorIsVisible() {
    const message = document.querySelector('#loginMessage');
    return Boolean(message && message.textContent.trim());
  }

  function retryLoginThroughHeaderLink() {
    const path = location.pathname.replace(/\/+$/, '') || '/';
    if (!/^\/login(?:\.php)?$/i.test(path) || loginErrorIsVisible()) return;

    let retries = 0;
    try { retries = Number(sessionStorage.getItem(LOGIN_RETRIES_KEY)) || 0; } catch {}
    if (retries >= MAX_LOGIN_RETRIES) return;

    const loginLink = [...document.querySelectorAll('a[href]')].find((link) => {
      try {
        const url = new URL(link.href, location.href);
        const label = (link.innerText || link.getAttribute('aria-label') || '').trim();
        return url.origin === location.origin && /\/login\/?$/i.test(url.pathname) &&
          link.getClientRects().length > 0 && /\blogin\b/i.test(label);
      } catch { return false; }
    });
    if (!loginLink) return;

    try { sessionStorage.setItem(LOGIN_RETRIES_KEY, String(retries + 1)); } catch {}
    loginLink.click();
  }

  let loginClicked = false;
  function clickSavedAccountLogin() {
    if (isServiceUnavailable()) return;
    const parts = findLoginButton();
    if (!parts || loginClicked) return;

    // Click the site's own button immediately. Let its native validation and
    // login handler report missing, invalid, or inactive accounts.
    if (!refreshTrailingOne(parts.username)) return;
    loginClicked = true;
    try { sessionStorage.setItem(RESUME_GAME_KEY, '1'); } catch {}
    parts.button.click();
    // If the submit leaves us on the login page without a site error, retry
    // through the visible header Login link. The retry count survives reloads.
    window.setTimeout(retryLoginThroughHeaderLink, 5000);
  }

  let routeTimer = 0;
  function maybeResumeRoute() {
    if (isServiceUnavailable() || routeTimer || findLoginButton()) return;
    const path = location.pathname.replace(/\/+$/, '') || '/';
    const isIndex = path === '/' || /^\/index(?:\.html?|\.php)?$/i.test(path);
    const isDashboard = /\/dashboard(?:\.php)?$/i.test(path);

    if (isDashboard) {
      try { sessionStorage.removeItem(LOGIN_RETRIES_KEY); } catch {}
      let resumeGame = false;
      try { resumeGame = sessionStorage.getItem(RESUME_GAME_KEY) === '1'; } catch {}
      if (!resumeGame) return;
      const gameLink = [...document.querySelectorAll('a[href]')].find((link) => {
        try { return /\/solving-colors\/?$/i.test(new URL(link.href, location.href).pathname); } catch { return false; }
      });
      if (!gameLink) return;
      routeTimer = window.setTimeout(() => {
        try { sessionStorage.removeItem(RESUME_GAME_KEY); } catch {}
        location.assign(gameLink.href);
      }, 1000);
      return;
    }

    if (!isIndex) return;
    const loginLink = [...document.querySelectorAll('a[href]')].find((link) => {
      try {
        const url = new URL(link.href, location.href);
        return url.origin === location.origin && /\/login\/?$/i.test(url.pathname) && link.getClientRects().length > 0;
      } catch { return false; }
    });
    if (!loginLink) return;
    routeTimer = window.setTimeout(() => {
      try { sessionStorage.setItem(RESUME_GAME_KEY, '1'); } catch {}
      location.assign(loginLink.href);
    }, 1000);
  }

  if (isServiceUnavailable()) {
    recover503();
    return;
  }
  try { sessionStorage.removeItem(RETRY_KEY); } catch {}
  window.setInterval(clickSavedAccountLogin, 1000);
  window.setInterval(maybeResumeRoute, 1000);
  new MutationObserver(() => { clickSavedAccountLogin(); maybeResumeRoute(); }).observe(document.documentElement, { childList: true, subtree: true, attributes: true });
  clickSavedAccountLogin();
  maybeResumeRoute();
})();
