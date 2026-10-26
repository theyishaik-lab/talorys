# Talorys field guide

Buildless, Hebrew RTL marketing and onboarding site. No analytics, credentials, backend calls or user data.

Source is versioned here. The Sites checkout is separate from the application checkout so its source helper cannot rewrite the application Git history. Copy these files and `../screenshots/{chat,tasks,memory,automations}.png` into the site's `dist/` (`assets/` for screenshots), preserving the site's own `.openai/hosting.json` identity. The screenshots are existing repository demonstration assets; they do not verify current production or new features.

Preview with a static HTTP server. Check responsive layouts, four screenshot tabs (mouse and keyboard), accordion steps, copy button, focus states and source links. The site is intentionally static and needs no dependency install or build.
