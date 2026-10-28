# Viral Studio checkpoint — 2026-10-29

## Current state

- Repository: `D:/DROPSHIP/APP Dropship/studio`
- Branch: `main`
- Release: `v0.5.13`
- Remote: `origin/main` on `github.com/minhpark89/dropship-studio`
- The portable app is `release/Viral Studio 0.5.13.exe`.
- The installer is `release/Viral Studio Setup 0.5.13.exe`.
- Only the current release artifacts remain in `release/`; old archives and test/build output were removed.
- User data stays local in `.studio/` and is intentionally not committed.

## Completed work in this checkpoint

- Research, News Content, Product Content, render queue, Library and Page-group scheduling are separated by output type.
- Research supports LLM fallback status, filtering, retrying missing LLM content and batch render controls.
- Content Studio supports filtering missing website posts, selecting individual/all posts, bulk LLM regeneration and bulk website publishing.
- Failed Content regeneration preserves the existing article and first comment.
- A successful Test LLM now saves the tested endpoint, model and key and enables LLM for later Research/Content generation.
- LLM failures expose a safe diagnostic message without exposing credentials.
- Meta Page groups balance Pages across token pools with round-robin assignment and per-token throttling.
- DreamFace profiles support authenticated proxies, proxy checking and Gmail autofill.

## Verification completed

- `npm test`: 166 tests passed.
- `npm run test:workspaces`: passed with no browser errors or horizontal overflow.
- `npm run build`: passed.
- `node tests/desktop.mjs --packaged`: passed for packaged version `0.5.13`; FFmpeg and FFprobe available; Node not exposed.
- `git diff --check`: passed; only line-ending warnings were reported by Git.

## Resume instructions

1. Start in `D:/DROPSHIP/APP Dropship/studio`.
2. Run `git status --short --branch` and read this checkpoint before changing code.
3. Run `npm test` and `npm run test:workspaces` after any fix.
4. Keep user data in `.studio/` local and never commit tokens, passwords, cookies, proxy credentials or generated media.
5. Bump the package version for every user-facing fix and add a new checkpoint with the release path and verification results.
6. The next likely verification task is to open v0.5.13, run Test LLM once in Settings, then regenerate the failed News Content record.
