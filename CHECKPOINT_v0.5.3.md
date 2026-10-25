# Viral Studio v0.5.3 — session handoff

Updated: 2026-10-25
Repository: `D:\DROPSHIP\APP Dropship\studio`
Branch: `main`
Verified commit: `81dd822` (`fix: load research thumbnails in desktop UI`)
Tag/release: `v0.5.3`

## Verified state

- Installed app: `C:\Users\Admin\AppData\Local\Programs\Viral Studio\Viral Studio.exe`
- Installed app reports version `0.5.3` from `/api/health`.
- GitHub release: https://github.com/minhpark89/dropship-studio/releases/tag/v0.5.3
- Current installer and portable artifacts are in `release/`.
- Application data is preserved outside the repository at `C:\Users\Admin\AppData\Local\Programs\Dropship Studio\Dropship Data`.
- DreamFace browser profiles are preserved in `.studio/profiles/`. Do not delete this directory: it contains the saved local profile sessions.

## Implemented in v0.5.3

- Research thumbnails: CSP allows `thumb.wikimedia.org`, `upload.wikimedia.org`, `commons.wikimedia.org` and `ichef.bbci.co.uk`.
- Research image cards load eagerly inside the scrollable workspace and show `Preview unavailable` if a source fails.
- AI news MC workflow: Highlight-compatible image endpoint first, DreamFace Image fallback, then DreamFace Avatar 3.0 Fast at 720p when the profile has the daily credit.
- News graphics use BBC red labels with centered text; news image motion uses zoom/pan/crossfade.
- Settings contains AI MC image endpoint/model/key masking and local Highlight detection.
- DreamFace profiles support local slots and least-recently-used rotation; local slots do not create a verified Gmail or bypass CAPTCHA.

## Validation already completed

- `npm test`: 131 passed, 0 failed.
- `npm run build`: passed.
- `npm run test:ui`: passed with no console errors or horizontal overflow.
- `npm run test:workspaces`: passed with no console errors or horizontal overflow.
- Installed app browser check: six Research thumbnails loaded with `naturalWidth > 0`; no console errors.
- v0.5.3 installer and portable files were uploaded to the GitHub release with SHA-256 checksums.

## Known limits for the next session

- The ready DreamFace profile showed `0 Free Daily` during the last live Avatar test, so a fresh Avatar 3.0 Fast video was not submitted then. The automation path is wired and will run when a profile has credit.
- Two additional local DreamFace slots were created for rotation and remain `needs_login` until the user completes official login/CAPTCHA.
- Existing Research records may contain old image-search results from before the thumbnail fix. Use `Tìm lại ảnh` once on those records to replace stale results; new searches use the filtered image pipeline.
- Do not print or commit credentials, cookies, API keys, or generated passwords.

## Suggested next actions

1. Read this file and run `git status --short`.
2. Check the installed app health and current DreamFace account statuses before live rendering.
3. Continue live DreamFace Avatar testing only with an authenticated profile that has daily credit.
4. Keep using `npm test`, `npm run build`, `npm run test:ui`, and `npm run test:workspaces` after changes.
5. Increment the version before the next packaged release; do not overwrite the v0.5.3 GitHub assets.
