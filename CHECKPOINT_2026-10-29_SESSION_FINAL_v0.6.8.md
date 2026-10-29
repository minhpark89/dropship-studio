# Viral Studio session checkpoint — 2026-10-29 — v0.6.8

## Recovery point

- Repository: `D:/DROPSHIP/APP Dropship/studio`
- Branch: `main`
- Commit: `cef3265` (`release: reschedule auto post slots after group time changes v0.6.8`)
- Tag: `v0.6.8`
- Remote: `https://github.com/minhpark89/dropship-studio.git`
- GitHub release: `https://github.com/minhpark89/dropship-studio/releases/tag/v0.6.8`
- Local user data: `%LOCALAPPDATA%/Programs/Dropship Studio/Dropship Data/studio.json`

## Implemented behavior at this checkpoint

- Auto Post uses eligible Content in creation order and no longer requires manually attaching a Page to every post.
- An enabled Page group materializes its selected local Pages from the saved Meta Page list.
- Group schedules use the group timezone; the current `test` group uses `Asia/Bangkok` (UTC+7).
- Changing a group's time reschedules future Auto Post slots to the new wall-clock time.
- The scheduler avoids creating duplicate future slots on repeated ticks.
- `Đăng ngay` can resolve the Page through the selected Auto Post group when a post has no manual Page binding.
- The Page and post control surface is kept in Channels & Tokens; the warehouse remains the source for videos and Content.

## User-data checkpoint

The last read-only inspection found 2 local social Pages, 8 social posts, 100 Meta Pages and 30 Meta tokens. The `test` group had 2 Pages, Auto Post enabled, daily limit `0` (use the configured time slots), and timezone `Asia/Bangkok`. One old future slot still reflected the previous 15:55 schedule; v0.6.8 now reschedules it automatically when the app starts or the scheduler ticks after the group is saved. No user data is deleted by this cleanup.

## Verification

- Full test suite before the final v0.6.8 scheduling patch: 171/171 passed.
- Latest social regression tests after the patch: 8/8 passed.
- Production build passed.
- Packaged v0.6.8 smoke check passed, including version `0.6.8`, FFmpeg, FFprobe and the browser runtime.
- The release checksum file was generated for the v0.6.8 artifacts.

## Release files

Keep the v0.6.8 portable executable, installer, installer blockmap, `latest.yml` and `SHA256SUMS.txt`. Older 0.6.0–0.6.7 portable/install artifacts are cleanup candidates. The current `release/win-unpacked` directory is the latest unpacked build; `release/win-unpacked.tmp` is a stale packaging staging directory and is a cleanup candidate after confirming no app process is using it.

## Cleanup record

The cleanup is intentionally limited to:

1. Old release binaries and installer artifacts whose version is below 0.6.8.
2. The stale `release/win-unpacked.tmp` staging directory.
3. Root-level generated verification files with the prefixes `_inspect_`, `_new_`, `_recovery_`, `_site_` and `_verify_` when their exact names are recorded in the cleanup command.

The recorded root-level candidates are:

```text
_inspect_download.mp4
_new_news_0.mp4
_new_news_0_a.png
_new_news_0_b.png
_new_news_1.mp4
_new_news_1_a.png
_new_news_1_b.png
_recovery_6bb923c2-cac3-436c-a240-5a5937deacc5.mp4
_recovery_8feb8e3e-65f1-4efc-bff5-9438a9c44f85.mp4
_site_c622.html
_site_check.html
_site_check2.html
_verify_news_0.png
_verify_news_1.png
```

Source code, Git history, checkpoints, project files, `Viral Data`/`Dropship Data`, current v0.6.8 artifacts, course files, research assets, and any media whose use cannot be ruled out are preserved.

## Resume procedure

1. Close any old Viral Studio window.
2. Install or run the v0.6.8 build from the GitHub release above.
3. Open Channels & Tokens → Bài đăng & trạng thái and refresh status. Auto Post should take eligible Content from the warehouse and assign the next Page/slot from the enabled group.
4. If a future slot was created under an old group time, wait for the scheduler tick or save the group once; v0.6.8 will move it to the current group time in `Asia/Bangkok`.

This file is the handoff point for the next session. Start by checking this file, `git status`, and the v0.6.8 release before making another change.
