# Viral Studio

Viral Studio is a Windows desktop app for research, AI video production, timeline editing, Facebook Page management, post planning and Meta publishing preparation.

## Download for Windows

- [Installer](https://github.com/minhpark89/dropship-studio/releases/download/v0.5.0/Viral.Studio.Setup.0.5.0.exe) — install to Windows and create the Desktop shortcut.
- [Portable](https://github.com/minhpark89/dropship-studio/releases/download/v0.5.0/Viral.Studio.0.5.0.exe) — run directly without installation.
- [SHA-256 checksums](https://github.com/minhpark89/dropship-studio/releases/download/v0.5.0/SHA256SUMS.txt)

The desktop app starts with a version/loading screen, uses the Viral Studio icon, and stores user data in `Viral Data`; an installed upgrade can read legacy `Dropship Data` automatically.

## Included features

- Batch production: choose News or Product, research a niche or supply a product, and create 1–50 independent videos. Each video keeps its source context for Content.
- Content uses the saved LLM to write complete English news articles, or short product first comments with the configured store link. News articles are included as `article.md` in handoff exports; drafts can be saved before assigning a Page.
- Bundled Inter font works offline, and the app shows its actual package version in the top bar and sidebar.
- Separate Channels, Content, Product and Research workspaces; Page selection, Meta token status and Page management.
- Content management with News/Product type, first comment, store or article link, approved render-library video selection, schedule and handoff export.
- DreamFace generation for news and product videos, local daily-rotation profiles, OpenAI-compatible research and FFmpeg render QA.
- News broadcasts save one official MC still per DreamFace profile, upload it before generation, select Avatar 3.0 Fast at 720p with the visible 1 Free Daily option, then compose the narrated presenter with smooth zoom, pan and crossfade transitions.
- DreamFace profiles can generate and save random sign-in details for reuse. Registration opens the official website and pauses for any CAPTCHA or verification; creating a local profile does not claim an authenticated account or create a Gmail inbox.
- Import the website domain, username and password from installed Highlight/Longform settings, test the connection, and explicitly publish a reviewed news article from Content. Its verified public URL becomes the first comment. Website passwords are encrypted separately from workspace snapshots.
- Settings include Store/website defaults and First Comment templates; Meta vault supports System User and Via Token with App ID/App Secret validation.
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

This repository is the dedicated Viral Studio project. The Windows v0.5.0 release is available from the [GitHub Releases page](https://github.com/minhpark89/dropship-studio/releases/tag/v0.5.0).
