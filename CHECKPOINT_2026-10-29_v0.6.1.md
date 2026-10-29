# Viral Studio v0.6.1 checkpoint

Date: 2026-10-29

## Delivered

- Regenerating a News Content record now automatically publishes the generated article when `Auto publish News article after render` is enabled and a saved website connection is active.
- The saved website connection writes its base URL back to the Content website default and becomes the active connection, preventing an older inactive site from being used accidentally.
- Successful website publishing updates the exact article URL and first comment in the returned Content record.
- Website failures are stored as `website_error` with the real error message so the UI can distinguish a website problem from an LLM problem.

## Verification

- Content and website tests, including automatic publish after regeneration: passed.
- Full serial test suite: 168 passed, 0 failed.
- Workspace browser test: passed, 0 browser errors.
- Packaged smoke test: passed; packaged version reported `0.6.1`, FFmpeg and FFprobe available.

## Test flow

1. Close older Viral Studio windows and open `release/Viral Studio 0.6.1.exe`.
2. Open Settings → Website publishing and confirm the active connection, then click `Test website` once.
3. Keep `Auto publish News article after render` enabled in Content defaults.
4. Open Content Studio → `Cần đăng web`, select the old News records and click `Regenerate LLM`.
5. The progress row should finish and each successful record should show the published website URL in its first comment without a separate login prompt.
