# Viral Studio v0.6.4 checkpoint

Date: 2026-10-29

## Delivered

- `Page & bài đăng` is now a post-control screen. It no longer repeats video thumbnails or filenames that already belong in Library/Kho.
- The screen shows Content completeness, Page, Page group, token-pool selection, scheduled time, Meta publishing state, first-comment errors, retry attempts and recent Meta publication history.
- Added status filters for missing Content, draft, ready, scheduled, publishing, error and published, plus title/Page/error search.
- Successful Meta publication records keep the post title and project metadata so the status history remains readable after the queue item is removed.
- Manual scheduling still works by selecting posts with complete Content; Auto Post continues to scan eligible Content automatically.

## Verification

- Vite build passed after the UI rewrite.
- Full serial suite: 170 passed, 0 failed.
- Workspace browser test passed with no console errors or horizontal overflow.
- Vite build passed; packaged smoke passed with version `0.6.4`, FFmpeg/FFprobe available and no desktop errors.

## Test flow

1. Close older Viral Studio windows and open `release/Viral Studio 0.6.4.exe`.
2. Open `Page & bài đăng` → `Bài đăng & trạng thái`.
3. Filter `Đã hẹn giờ` to see posts assigned to the Page group, then filter `Đang đăng`, `Lỗi` or `Đã đăng Meta` to follow the scheduler and first comment.
4. Use `Thư viện` for video files and this screen only for post distribution/status.
