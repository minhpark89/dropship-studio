# Research, LLM and DreamFace continuation contract

This extension adds a local editorial research workspace to Viral Studio.

- LLM configuration is stored only in the local Store. API keys never enter the public state snapshot, event stream, logs, export packages, or browser renderer state.
- Research fetches a bounded set of configured RSS/Atom feeds, deduplicates articles, and asks an OpenAI-compatible JSON endpoint to select an angle, write a short script, and suggest image queries. If the endpoint is unavailable, the result remains usable with feed summaries and a visible warning.
- Article image URLs are metadata only until the user explicitly imports them. Remote media is never downloaded from an LLM-generated arbitrary filesystem path.
- An explicit result action can import bounded public article images into the local media library, then append the imported images as five-second clips to the project timeline for the existing Editor/FFmpeg renderer.
- An explicit result action can search bounded public Wikimedia Commons image results for generated image queries, show attribution/license metadata, and import at most twelve validated public images into the local media library.
- DreamFace is a separate provider with an owned browser profile. Automation may open the site headlessly for an already authenticated account; interactive login and the optional Gmail signup assistant reveal the browser. The assistant uses the profile's saved credentials and optional proxy, keeps CAPTCHA/OTP/phone verification in the visible browser for the user, and never bypasses verification. Rendering still requires a verified DreamFace session.
- Browser visibility is controlled by `settings.browserVisible` and defaults to `false`; login and account-open actions explicitly request a visible window.
- Research results are project scoped and persisted. The explicit News Broadcast action uses the selected result as its source, ranks matching editorial images, creates the narrated DreamFace job and keeps provider submission behind that user click; research alone never submits a paid provider job.

The root agent owns Store migration, server mounting, provider registration, frontend navigation, QA and checkpoint updates. Independent agents may implement the research service/UI and DreamFace provider/UI only after these shared contracts are present.

