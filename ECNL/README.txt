ECNL Solving Colors Helper — Chrome unpacked extension

Install/update:
1. Open chrome://extensions in Chrome.
2. Find the existing ECNL helper and click Reload after replacing its files, or remove it and load this folder again.
3. To install fresh, turn on Developer mode, choose Load unpacked, and select this folder (the folder containing manifest.json).

Flow:
- On the site's index page, the extension opens the login page.
- On the login page, only when the username field exactly contains “Nainai01”, it focuses that field, removes and retypes only the final “1”, dispatches input/change events, then immediately clicks the visible, enabled #loginBtn. Other saved usernames and the password are untouched. If the page remains on /login after 5 seconds with no text in #loginMessage, it clicks the visible header Login link and lets the normal login flow retry, up to three times. A validation/account error stops retries; normal site validation still applies.
- After that login flow reaches the dashboard, it follows the dashboard's Solving Colors link and starts the puzzle helper.
- If logout redirects to index or login, the same flow runs again. If the site reports “Usernames are required to be alphanumeric, and between 3-16 characters long” or “Account not activated!”, the site rejected the account data or status; navigation retries stop and cannot override that validation.
- A 503 Service Unavailable page is retried with Chrome's cache-bypassing reload API. Waits grow from 30 seconds to a maximum of 5 minutes while the outage continues.

The toolbar button hard-refreshes the active tab. Shortcut: Ctrl+Shift+Y; change it at chrome://extensions/shortcuts.
The extension does not use withdrawal controls or submit financial transactions.

