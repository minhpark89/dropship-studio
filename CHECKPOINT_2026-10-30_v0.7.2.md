# Viral Studio v0.7.2 checkpoint

This release includes the Page/post management work previously verified in a local prerelease, plus returned warehouse posts, selection-wide content editing, successful-publication cleanup and a startup paint fix. The package/UI version is exactly `0.7.2`; there is no local suffix.

## User workflows

- **Page & bài đăng:** the default list shows the active queue and warehouse. Published records are accessible explicitly through **Lịch sử đã đăng**. Search/filter by status, Page, group, project, type, error and date; pagination 25/50/100; select matching results across pages and export CSV.
- **Sửa N bài đã chọn:** edits individual title/caption/first comment/News body/notes, or applies a field to the selection. Ten editors per page; edits persist across editor pages. Server preview validates current revisions and reports busy/stale/immutable rows. Saving puts changed drafts on hold and does not publish. Details include previous/next navigation through selected posts.
- **Trả về kho:** preserves the media and full Content post, remembers the prior Page/group/error, clears old Page/token-group/schedule assignments and stops automation. It appears in both the management warehouse filter and Content Studio's returned filter. Reassign explicitly to reuse; returning a video already present in the publication ledger is blocked.
- Nonretryable publishing failures, or transient failures after three attempts, return to stock automatically. Existing held `meta_error` drafts migrate on opening. Comment-only failures never return a live video to stock.
- Successful video + first-comment publication removes the queue draft and deletes its local media only when it has no remaining post/timeline/active-job references and all paths resolve inside the data directory. Retained shared media is marked as published so warehouse sync does not create a duplicate. Publication records keep media IDs, idempotency keys and the Facebook link.
- Page manager supports health/lifecycle/group/token/source/reminder filters, detail/history, move/add/remove group, review/restore/archive/trash and import from selected token Pages or CSV/TSV/JSON/ID lists. Tombstones survive sync/import. Returning a restricted Page requires explicit resolution confirmation; a read-only check does not certify publishability or automatically remove restrictions.

## Main code

- `server/management.js`, `shared/management.js`: unified rows, bulk preview/apply, import and check queues; warehouse migration, selection edits and lifecycle guards.
- `server/post-lifecycle.js`: publication ledger guard, return-to-stock state and guarded media cleanup.
- `server/meta-errors.js`, `server/meta.js`, `server/social-scheduler.js`: classified retries, Page restriction hold, persisted partial publication and comment-only continuation.
- `server/social.js`: explicit scheduling and hold behavior. `automationHold` prevents a manually paused/edited/reassigned draft from being silently picked up by daily automation; explicit approval/scheduling releases the hold.
- `src/pages/Management.jsx`, `BulkPostEditor.jsx`, `management.css`: large-list manager and selected content editor. `Content.jsx` exposes returned drafts and excludes already-published unassigned media.
- `desktop/main.cjs`: hidden splash waits for first paint; main window waits for both paint and a same-window/same-origin renderer readiness signal. `preload.cjs` exposes only the readiness notification and existing data-folder action. `src/main.jsx` notifies after initial data/error is rendered; `index.html` has an immediate dark loading state.

## Verification performed before publication

- 224 Node tests passed, including large lists (1,100 Pages / 1,450 post rows), read-only previews, stale/busy guards, CSV/token import, review restoration, rate-limit/cancellation, content edits, warehouse round trips and file cleanup boundaries.
- Synthetic Playwright manager test passed with 1,000 Pages and 350 queue/history rows: group workflow, archive/restore, CSV, token selection, ten selected edits with different captions and a shared first comment, selected-detail navigation, ten returned posts visible in Content Studio and a 1024px layout. No external writes.
- Retry UI test passed with no external requests and unchanged retry counters.
- Electron startup probe captured the first visible frame of both windows: each was initially hidden; splash and main contained rendered content with dark backgrounds, not a blank white surface. Main DOM was populated before show.
- Frontend build and whitespace validation passed. Vite reports a bundle-size advisory; no build failure.
- Packaged portable was launched with isolated data: version 0.7.2, Chrome, FFmpeg/FFprobe and management endpoints passed. Production data remained unchanged by that test. ASAR source and dependencies were checked against this checkout.
- Local upgrade was verified against the real workspace: four held drafts automatically returned with content and media intact; four previously published, unreferenced videos were backed up and cleaned; four history records and links remained. Selection editing was previewed for four real drafts without changing their contents. Account/project/token/Page data and retry counts were preserved; no new production post was published.
- Portable SHA-256: `439f22002685d1bdb30223727f74f999d582706718c89cfa4ecd793a8670f579` (173,139,867 bytes). Installer SHA-256: `2806b5789a15bee70332a2dd10d014c2075dde155b096db8fd2b13605e7fe724` (173,401,186 bytes).
- Runtime screenshots, local data backups and environment-specific rollout details are deliberately outside the public repository.

## Build / continuation

Use Node 22 and the repository's own dependency directory (avoid a junction to another checkout when packaging; electron-builder can omit transitive dependencies). Run `npm test`, `npm run build`, `node tests/management-ui.mjs`, `node tests/meta-retry-ui.mjs`, then `npm run pack:release`.

Artifacts: `release/Viral.Studio.0.7.2.exe`, `release/Viral.Studio.Setup.0.7.2.exe`, installer `.blockmap`, `latest.yml`, `SHA256SUMS.txt`. Release URL: https://github.com/minhpark89/viral-studio/releases/tag/v0.7.2.

Never commit `.verification`, user data, browser profiles, tokens or secret stores. Before replacing a running desktop app, check active jobs/posts/profile setup, take a fresh data snapshot, close the current app gracefully and verify the new owner/health after launch. Do not remove compatibility junctions or re-run live publishing test scripts against already-published posts. Meta account restrictions still require resolution on Facebook.
