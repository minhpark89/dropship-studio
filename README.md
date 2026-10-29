# Viral Studio

Viral Studio is a Windows desktop app for research, AI video production, timeline editing, Facebook Page management, post planning and Meta publishing preparation.

## Download for Windows

- Portable v0.6.7: `release/Viral Studio 0.6.7.exe`
- Installer v0.6.7: `release/Viral Studio Setup 0.6.7.exe`
- SHA-256 checksums: `release/SHA256SUMS.txt`

The desktop app starts with a version/loading screen, uses the Viral Studio icon, and stores user data in `Viral Data`; an installed upgrade can read legacy `Dropship Data` automatically.

## Included features

- Batch production: choose News or Product, research a niche or supply a product, and create 1–50 independent videos. Each video keeps its source context for Content.
- Content uses the saved LLM to write complete English news articles, or short product first comments with the configured store link. News articles are included as `article.md` in handoff exports; drafts can be saved before assigning a Page.
- Bundled Inter font works offline, and the app shows its actual package version in the top bar and sidebar.
- Separate Channels, Content, Product and Research workspaces; Page selection, Meta token status and Page management.
- Content management with News/Product type, first comment, store or article link, approved render-library video selection, schedule and handoff export.
- DreamFace generation for news and product videos, local daily-rotation profiles, OpenAI-compatible research and FFmpeg render QA.
- Research image cards allow Wikimedia and article thumbnails through the local UI policy and load them eagerly with a visible fallback when a source is unavailable. News broadcasts automatically create one original AI MC still per DreamFace profile from the saved Highlight-compatible image endpoint, upload it before generation, prefer Avatar 3.0 Fast at 720p, recognize DreamFace's quota-prefixed Generate button, and fall back to an available avatar/resolution when the account does not expose that exact option. The result composes a narrated presenter with a fact-based hook, complete editorial images in a framed card, smooth zoom, pan and crossfade transitions. DreamFace Image is the automatic fallback when the primary image endpoint is unavailable.
- DreamFace profiles can generate and save sign-in details for reuse. The **Tạo Gmail & đăng nhập** action creates a unique Gmail-shaped local credential (it does not create a Google inbox), opens DreamFace in the visible profile, fills/submits the credentials, and pauses for CAPTCHA or other verification in the user's browser. CAPTCHA is never bypassed.
- Import the website domain, username and password from installed Highlight/Longform settings, test the connection, and publish a generated News article automatically after render when the setting is enabled (or review it from Content first). Its verified public URL becomes the exact first comment for the matching video; website or LLM errors stay visible on the Content post with a one-click regeneration action. Website passwords are encrypted separately from workspace snapshots.
- Optional Meta auto-post runs only after the website URL and first comment are confirmed, then publishes the matching Reel and its first comment to the bound Page. It remains off until enabled in Content settings and requires a local Page mapped to the Meta Page.
- Settings include Store/website defaults and First Comment templates; Meta vault supports System User and Via Token with App ID/App Secret validation.
- Settings now discovers OpenAI-compatible models automatically; Render has separate News/Product modes and a fast 480p draft action.
- Page distribution now has a Content warehouse: completed videos create separate Content drafts, Page groups assign them round-robin, and scheduled posts are published by the local scheduler after Meta preflight. A group can automatically take new warehouse videos into its daily time slots, while any Page can also receive a post-now action. News batches can pin one DreamFace profile for the same MC, while each video receives a distinct visual variation.
- Token pools now mirror the Highlight workflow: choose healthy Meta tokens, save a pool, then use **Tự chia Page** to assign verified Pages evenly by round-robin, least-recently-used or random strategy. Each pool records Page/token assignments, load counts and blocked Pages; a Page group can bind a token pool so daily warehouse automation uses the same assignment without asking again for every video.
- News render accepts either a keyword or a direct article URL, then uses the article as the source for the presenter video and Content draft. The render panel keeps the main action small and offers News standard, Viral bold and Minimal font/style presets.
- Research feed, AI video generation providers, timeline editing and Windows packaging. News graphics use a neutral US-news label, a red/yellow broadcast palette, readable condensed typography and keep the source in the lower bar.

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

This repository is the dedicated Viral Studio project. The current verified local build is v0.6.7. Previous artifacts are kept under versioned `release/archive-*` folders for reference.


