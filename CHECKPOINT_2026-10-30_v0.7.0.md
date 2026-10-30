# Viral Studio v0.7.0 checkpoint

## Why this release exists

The workspace moved from v0.6.9 to v0.7.0 while keeping the ready 2Captcha CAPTCHA solver, fixing the slow DreamFace login path, and replacing bulk profile creation that opened every Chrome window at once.

## What changed

- **CAPTCHA solver · 2Captcha kept:** settings panel, encrypted local key, balance check, `/api/captcha`, per-account solve and automatic solving during DreamFace login.
- **Faster DreamFace login:** promotional overlays no longer swallow the login click. The login form is retried and opens in about 4 seconds instead of waiting 15s + 20s blindly; post-submit waits react to real page signals.
- **Hidden profile setup queue:** bulk profiles are signed in by a server-side queue in headless Chrome. Each profile is closed as soon as it is ready and the next one starts; no verification window is opened.
- **Chrome lanes:** profile setup can run 1–4 hidden Chrome instances in parallel, chosen in the bulk-profile modal or in Settings → Hàng đợi & theo dõi. Default is 1.
- **Manual fallback:** if 2Captcha cannot finish a profile, the hidden session is closed, the profile is marked `needs_login`, and the account card still offers Giải CAPTCHA / Đăng nhập.

## Verification

- `npm run build` passes.
- `node --test` passes 156 tests including 15 CAPTCHA tests and 4 setup-queue tests (hidden, ready polling, concurrency, busy skip).
- 32 browser/FFmpeg tests cannot run on this machine because the Playwright Chromium binary is absent and ffmpeg is not on PATH; this is an environment limitation, not a regression.
- UI smoke test with a temporary data directory verified Accounts, the bulk-profile modal, the concurrency field and the 2Captcha panel.

## Data and disk

- Chrome profile data lives in `<data dir>/profiles/<accountId>`, which is `E:\OPENCLAW\VIRAL STUDIO\repo\.studio\profiles` for the source shortcut. Nine profiles used about 1.2 GB (~130 MB each).
- Browser binaries (Chrome/Edge or Playwright Chromium) live on C; profile data does not.
- DreamFace renders video in its cloud; Chrome only drives the session. Local FFmpeg performs final assembly/export.

## Artifacts

- Portable: `release/Viral Studio 0.7.0.exe`
- Installer: `release/Viral Studio Setup 0.7.0.exe`
- Checksums: `release/SHA256SUMS.txt`
