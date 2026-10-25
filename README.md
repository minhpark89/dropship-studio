# Viral Studio

Viral Studio is a Windows desktop app for research, AI video production, timeline editing, Facebook Page management, post planning and Meta publishing preparation.

## Download for Windows

- [Installer](https://github.com/minhpark89/dropship-studio/releases/download/v0.3.1/Viral.Studio.Setup.0.3.1.exe) — install to Windows and create the Desktop shortcut.
- [Portable](https://github.com/minhpark89/dropship-studio/releases/download/v0.3.1/Viral.Studio.0.3.1.exe) — run directly without installation.
- [SHA-256 checksums](https://github.com/minhpark89/dropship-studio/releases/download/v0.3.1/SHA256SUMS.txt)

The desktop app starts with a version/loading screen, uses the Viral Studio icon, and stores user data in `Viral Data`; an installed upgrade can read legacy `Dropship Data` automatically.

## Included features

- Separate Channels, Content, Product and Research workspaces; Page selection, Meta token status and Page management.
- Content management with News/Product type, first comment, store or article link, approve, schedule and handoff export.
- DreamFace generation for news and product videos, local rotation slots, OpenAI-compatible research and FFmpeg render QA.
- Settings now discovers OpenAI-compatible models automatically; Render has separate News/Product modes and a fast 480p draft action.
- Research feed, AI video generation providers, timeline editing and Windows packaging.

## Run from source

Requires Node.js 22 and FFmpeg/ffprobe from `bin/` or `PATH`.

```powershell
npm ci
npm run build
npm run desktop
```

## Build Windows artifacts

```powershell
npm ci
npm test
npm run build
npm run pack:release
```

Build outputs are written to `release/`. The installer and portable executable use the icon in `build/icon.ico`. Runtime data, browser profiles, tokens and secrets are excluded from the repository.

## Repository

This repository is the dedicated Viral Studio project. The Windows v0.3.1 release is available from the [GitHub Releases page](https://github.com/minhpark89/dropship-studio/releases/tag/v0.3.1).
