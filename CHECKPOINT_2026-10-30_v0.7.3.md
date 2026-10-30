# Viral Studio v0.7.3 — Accounts workspace and Meta post updates

Base: `v0.7.2` (Meta post lifecycle, publishing health and Management workspace), fast-forwarded onto the previously published v0.7.0 `main`.

## Changes

- **Accounts overview redesigned as horizontal rows.** Each profile is one compact row: identity/avatar, provider and sign-in method, proxy state, status/message and actions. The tall cards and duplicated hero actions were removed.
- **Professional filter bar.** Search covers name, email and proxy; provider segmented control; multi-select status chips with counts (`Cần xử lý`, `Sẵn sàng`, `Cần đăng nhập`, `Cần xác minh`, `Chưa kiểm tra`, `Đang chạy`); proxy chips (`Có proxy`, `Không proxy`, `Proxy lỗi`); sort by attention, name or creation time; one-click clear.
- **Multi-select bulk actions.** Select visible rows or all filtered rows, then assign proxy, remove proxy, start the hidden DreamFace sign-in queue, re-check sessions or solve pending CAPTCHAs.
- **Bulk proxy API** `POST /api/accounts/proxy-bulk`. Accepts 1 proxy for the whole selection or exactly N proxies for N profiles, stores credentials in the encrypted secret store, skips busy profiles, resets stale proxy check state and marks previously ready profiles for re-checking.
- **Single-profile proxy edits** now also clear `proxyStatus`, `proxyIp` and `proxyCheckedAt`, and the proxy dialog has an explicit **Bỏ proxy** action.
- All existing per-profile actions remain: check session, open browser, edit/test proxy, connect saved profile, Gmail sign-up/check, auto CAPTCHA, cookie import, Google session reuse and delete.

## Verification

- `node --test tests/state.test.js tests/dreamface-setup.test.js tests/management.test.js tests/meta.test.js tests/meta-errors.test.js tests/post-lifecycle.test.js tests/social.test.js tests/social-scheduler.test.js` → 68/68 pass. This includes the new bulk-proxy API test (shared proxy, per-profile proxies, clear, mismatched line count and DreamFace-only guard).
- Headless Chrome UI run at 1440×1000 and 640×900: 9 seeded accounts render as rows under 100 px tall; status/proxy/search/provider filters; row action menu; select-all; bulk set/clear proxy verified through `/api/state`; mobile reflow keeps actions reachable; no console errors.
- Browser-dependent tests that need the missing Playwright Chromium download still cannot run in this environment; the source build and packaged app use the system/bundled browser paths unchanged.

## Artifacts

- `release/Viral.Studio.0.7.3.exe` (portable)
- `release/Viral.Studio.Setup.0.7.3.exe` (NSIS)
- `release/Viral.Studio.Setup.0.7.3.exe.blockmap`, `release/latest.yml`, `release/SHA256SUMS.txt`

Packaging on Node 22.2.0 requires `NODE_OPTIONS=--experimental-require-module` for electron-builder's ESM dependency graph.
