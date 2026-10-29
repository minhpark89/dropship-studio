# Viral Studio checkpoint — 2026-10-29 — v0.5.14

## Fix in this release

- News Content generation now has a dedicated timeout of up to 300 seconds.
- The short Test LLM request keeps its normal Settings timeout; long article generation no longer fails at the same 90-second limit.
- Timeout errors now report `LLM timed out after ... seconds while generating content.`
- Existing Content is still preserved when regeneration fails.

## Release and verification

- Portable: `release/Viral Studio 0.5.14.exe`
- Installer: `release/Viral Studio Setup 0.5.14.exe`
- `npm test`: 166 passed.
- `npm run test:workspaces`: passed with no browser errors or horizontal overflow.
- `npm run build`: passed.
- `node tests/desktop.mjs --packaged`: passed for packaged version `0.5.14`; FFmpeg and FFprobe available; Node not exposed.
- SHA256 checksums are in `release/SHA256SUMS.txt`.

## User verification

1. Close the running v0.5.13 window.
2. Open `Viral Studio 0.5.14.exe`.
3. Go to Settings and press Test LLM once so the tested configuration is saved.
4. Open Content Studio and press `Regenerate with LLM` on the two old News posts.
5. Wait for the article request to finish; the longer timeout is intentional for a 500–800 word article.

## Resume instructions

- Start in `D:/DROPSHIP/APP Dropship/studio`.
- Read this checkpoint and the previous v0.5.13 checkpoint before changing code.
- Keep `.studio/` local; never commit tokens, passwords, cookies, proxy credentials or generated media.
- Bump the package version and add a checkpoint for every user-facing fix.
