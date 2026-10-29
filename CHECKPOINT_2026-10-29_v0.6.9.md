# Viral Studio v0.6.9 checkpoint

## Why this release exists

The source metadata already identified the product as Viral Studio, but an old `release/win-unpacked/Viral Studio.exe` still contained file version 0.6.7. The installed folders also contained older legacy builds. This release rebuilds the unpacked executable from a clean directory and increments the application version to 0.6.9 so the running build is unambiguous.

## Naming and release

- Product name: `Viral Studio`
- Package name: `viral-studio`
- Version: `0.6.9`
- App ID: `local.viral.studio`
- GitHub repository: `https://github.com/minhpark89/viral-studio`
- Release tag: `v0.6.9`
- Portable artifact: `release/Viral Studio 0.6.9.exe`
- Installer artifact: `release/Viral Studio Setup 0.6.9.exe`
- The installer and portable executable report ProductName `Viral Studio` and file version `0.6.9`.

## Build verification

- `npm run pack:release` passed from a clean `release/win-unpacked` directory.
- `node tests/desktop.mjs --packaged` passed with packaged version `0.6.9`.
- FFmpeg, FFprobe and the browser runtime were available in the packaged app.
- The old unpacked 0.6.7 executable was removed before packaging.

## Installation note

The Desktop shortcuts now target `C:/Users/Admin/AppData/Local/Programs/Viral Studio/Viral Studio.exe`, but that installed location must be updated with the v0.6.9 installer. A shortcut can otherwise continue opening an older installed copy even when the repository release is newer.

## Recovery

The prior scheduler checkpoint remains at `CHECKPOINT_2026-10-29_SESSION_FINAL_v0.6.8.md`. Git history and tags remain available for rollback; this release only changes package metadata, rebuilds the current unpacked app and republishes the Viral Studio artifacts.
