# Dropship Studio

Dropship Studio is a Windows desktop app for research, AI video production, timeline editing, Facebook Page management, post planning and Meta publishing preparation.

## Download for Windows

- [Installer](https://github.com/minhpark89/dropship-studio/releases/download/v0.1.0/Dropship.Studio.Setup.0.1.0.exe) — install to Windows and create the Desktop shortcut.
- [Portable](https://github.com/minhpark89/dropship-studio/releases/download/v0.1.0/Dropship.Studio.0.1.0.exe) — run directly without installation.
- [SHA-256 checksums](https://github.com/minhpark89/dropship-studio/releases/download/v0.1.0/SHA256SUMS.txt)

The desktop app starts with a version/loading screen, uses the Dropship Studio icon, and stores user data in `Dropship Data` beside the portable executable or inside the installed application directory.

## Included features

- Page overview with Page selection, Meta connection/token status and Page management.
- Post management with create, edit, approve, schedule, preview, duplicate and export actions.
- OpenAI-compatible LLM endpoint settings, including local Ollama and LM Studio endpoints.
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

This repository is the dedicated Dropship Studio project. The Windows v0.1.0 release is available from the [GitHub Releases page](https://github.com/minhpark89/dropship-studio/releases/tag/v0.1.0).
