# Viral Studio v0.6.0 checkpoint

Date: 2026-10-29

## Delivered

- News Content bulk regeneration now has a selectable LLM thread count from 1 to 8.
- Bulk LLM work runs with a worker pool, keeps each post result, shows `completed / total`, active threads, success count and failure count, and reports each returned automation error instead of stopping silently.
- News source text sent to the LLM is bounded per source and JSON generation is capped to keep requests responsive.
- Page Groups now show `AUTO POST: ON/OFF` and have a direct `Bat Auto Post` / `Tat Auto Post` action beside `Sua lich`.
- Auto Post toggle honors an explicit off value. A group must have at least one configured time before it can be enabled.
- Release folder was cleaned to keep the current v0.6.0 artifacts. The locked v0.5.14 portable executable was left in place because a running process still owns it.

## Verification

- `node --test --test-concurrency=1 tests/*.test.js` — 167 passed, 0 failed.
- `npm run test:workspaces` — passed, 0 browser errors.
- `npm run build` — passed.
- `npm run pack:release` — passed.
- `node tests/desktop.mjs --packaged` — passed; packaged version reported `0.6.0`, FFmpeg and FFprobe available.

## Release files

- `release/Viral Studio 0.6.0.exe`
- `release/Viral Studio Setup 0.6.0.exe`
- `release/Viral Studio Setup 0.6.0.exe.blockmap`
- `release/latest.yml`
- `release/SHA256SUMS.txt`

## Test flow

1. Open `Viral Studio 0.6.0.exe`.
2. Go to `Content Studio` → filter `Cần đăng web`.
3. Select all or leave no selection to process all filtered News posts.
4. Set `LLM threads` to 2–4, click `Regenerate LLM`, and watch the progress row until it reaches `total`.
5. Go to `Channels & Tokens` → `Nhóm phân phối`.
6. Open `Sửa lịch` on a Page Group, set at least one future time, Page mapping and token pool, save, then click `Bat Auto Post` on that group.
7. Confirm the badge changes to `AUTO POST: ON`. A ready News post with video, article and first comment will be picked into the Meta queue by the scheduler.
