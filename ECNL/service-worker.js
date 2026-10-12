async function hardRefresh(tabId) {
  try {
    if (tabId == null) {
      await chrome.tabs.reload(undefined, { bypassCache: true });
    } else {
      await chrome.tabs.reload(tabId, { bypassCache: true });
    }
  } catch (error) {
    console.error('ECNL hard refresh failed:', error);
  }
}

chrome.action.onClicked.addListener((tab) => {
  hardRefresh(tab.id);
});

chrome.commands.onCommand.addListener((command) => {
  if (command === 'hard-refresh-current-tab') hardRefresh();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'ECNL_BYPASS_CACHE_RELOAD' || sender.tab?.id == null) return;

  let allowedOrigin = false;
  try {
    const url = new URL(sender.url || '');
    allowedOrigin = url.origin === 'https://ecnlmediamarket.com' || url.origin === 'https://www.ecnlmediamarket.com';
  } catch {}
  if (!allowedOrigin) return;

  sendResponse({ ok: true });
  hardRefresh(sender.tab.id);
});
