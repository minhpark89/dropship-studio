# Viral Studio v0.6.3 checkpoint

Date: 2026-10-29

## Delivered

- An enabled Page group now scans every completed generated video with complete Content, including Content created manually from the Library. It assigns eligible records to the configured Page slots and schedule.
- After Meta confirms the Reel and the first comment succeeds, the local social post is removed and the video file, thumbnail and preview are cleaned from Media Library when no timeline, active job or other post still references them.
- If the first comment fails, the post and video stay available for the retry path. If another local record still uses the same media, cleanup is skipped and recorded safely.

## Verification

- Meta publish tests verify cleanup after a successful first comment and retention after a first-comment failure.
- Page-group tests verify auto-scheduling for both render automation records and manually created Content attached to a generated video.
- Full serial suite: 170 passed, 0 failed.
- Targeted Meta/social suite: 22 passed, 0 failed; workspace browser test passed.
- Vite build passed; packaged smoke passed with version `0.6.3`, FFmpeg/FFprobe available and no desktop errors.

## Token pool setup

1. Open `Pages & Tokens` → `Nhóm phân phối` → `Pool token` → `Tạo pool`.
2. Select the verified Meta tokens, choose `Luân phiên đều` or `Token ít dùng nhất`, and leave `Giới hạn Page / token` at `0` for automatic balancing.
3. Click `Tự chia Page`. The pool reports the assigned Page count and load for each token.
4. Edit the Page group schedule, choose that pool under `Pool token tự động`, keep `AUTO POST ENABLED`, and save.

For 30 tokens and an uneven Page count, automatic assignment keeps the groups balanced (for example, 3 or 4 Pages per token) while skipping unhealthy tokens.

## Test flow

1. Close older Viral Studio windows and open `release/Viral Studio 0.6.3.exe`.
2. In Pages & Tokens, make sure the Page group has the two Pages, future times, token pool and `AUTO POST: ON`.
3. Create or confirm a completed generated video with Content and first comment. Leave it without a Page group; the scheduler will pick it up on its next cycle and assign it to the next Page slot.
4. At the scheduled time, Meta publishes the Reel, adds the first comment, removes the queue record and cleans the local media when it is safe to do so.
