# Viral Studio v0.6.2 checkpoint

Date: 2026-10-29

## Delivered

- News created from a completed render now uses the saved website connection automatically when Auto publish News is enabled.
- The Content page no longer sends a second manual website request after the server has handled auto-publish.
- Website login or publishing failures are returned on the Content record as `website_error` with the real message; the generated article remains available for retry.
- Regenerating an existing News record keeps the same automatic publish behavior.

## Verification

- Content and website tests passed.
- Full serial test suite: 169 passed, 0 failed.
- Workspace browser test passed.
- Packaged smoke test passed for v0.6.2 with FFmpeg and FFprobe available.

## Test flow

1. Close older Viral Studio windows and open `release/Viral Studio 0.6.2.exe`.
2. Open Settings → Website publishing, select the saved connection and click `Test website`.
3. Keep `Auto publish News article after render` enabled.
4. In Content Studio, choose a completed News render and click `Tạo bài + đăng website`.
5. A successful record shows the verified article URL in its first comment. If the website rejects the request, the record stays available and shows the website error instead of asking for a separate login flow.
