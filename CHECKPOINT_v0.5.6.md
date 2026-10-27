# Viral Studio v0.5.6 — session checkpoint

Repository: `D:\DROPSHIP\APP Dropship\studio`
Branch: `main`
Release: `0.5.6`

## Current workflow

- News render accepts either a keyword for research or a direct HTTPS article URL.
- One render panel exposes count, MC/profile and three real bundled font families: Barlow Condensed for News, Anton + Barlow for Viral, and Be Vietnam Pro for the clean viral style.
- Completed render videos become Content warehouse drafts. A Page group can take new warehouse videos into daily slots, and a single item can be posted immediately.
- Meta token pools support automatic Page distribution. The pool records verified Page-to-token assignments and load counts; `round_robin`, `least_recently_used` and `random` strategies are available. Page group schedules can bind a pool so the scheduler reuses the same distribution.
- Research & News no longer crashes when an existing research result is rendered. The old `accounts` scope error was fixed.

## Validation

Run from the repository root:

```powershell
npm test
npm run build
npm run test:ui
npm run test:workspaces
```

The latest source checkpoint has the token-pool auto-assignment test in `tests/meta.test.js`. Packaging is local-only and produces the ignored files under `release/`; do not commit generated installers or runtime data.

## Safe continuation

1. Read this file and run `git status --short`.
2. Keep `.studio/` and the installed Viral Data directory; they contain browser profiles, workspace data and user-owned credentials.
3. Never print, commit or copy Meta tokens, cookies, App Secrets, DreamFace sessions or generated passwords.
4. Keep the local scheduler process running while testing daily posting. Live Meta and DreamFace checks require the user’s own authenticated accounts and should be tested explicitly.
5. If a release is rebuilt, refresh `release/SHA256SUMS.txt` and verify the packaged smoke test before changing the GitHub checkpoint.
