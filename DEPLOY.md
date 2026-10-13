# Yishai's deployment — quick reference

Full documentation: **[docs/README.md](docs/README.md)** (architecture, deploy, connections, UI, mobile,
models, secrets, roadmap). This page is the short version.

> ⚠️ **Never run `npx create-talorys update` on this installation.** It redeploys the published npm
> package and removes the OpenConnector integration. Deploy from this fork
> ([docs/system/DEPLOY.md](docs/system/DEPLOY.md)).

| | |
| --- | --- |
| App | https://talorys-lxl5w9o0-web.pages.dev (agent `0.1.15-endpoints` from this fork + OpenConnector tools, installation `lxl5w9o0`) |
| Cloudflare account | `25e3dffccdb99cd3801798bcc4a5b54a`, free plan, no card; login email is Tab's mailbox for Yishai |
| Agent Worker | `talorys-lxl5w9o0-agent` (private) — deployed from this repo's `main` with `deploy/agent.wrangler.jsonc` |
| Web | Pages project `talorys-lxl5w9o0-web` |
| Model | Chosen in Settings → Model (Workers AI / Gemini / OpenRouter) with a fallback chain — [docs/system/MODELS.md](docs/system/MODELS.md) |
| OpenConnector | Worker `open-connector`, https://open-connector.yishai-kaminsky.workers.dev ([theyishaik-lab/open-connector](https://github.com/theyishaik-lab/open-connector)) |
| Phone app | Native Android app `dev.talorys.app` (`apps/mobile`, APKs as `native-v0.1.x` GitHub releases) — [docs/system/MOBILE.md](docs/system/MOBILE.md). Or install the web app from Chrome / iOS Add to Home Screen — [docs/system/NOTIFICATIONS.md](docs/system/NOTIFICATIONS.md) |
| App timezone | `Asia/Jerusalem` (app setting) |

## Deploy in three lines

```bash
npm install && npm run typecheck && npm test -w @talorys/agent
CLOUDFLARE_API_TOKEN=... npx wrangler deploy --config deploy/agent.wrangler.jsonc     # agent
# web: build, then deploy dist + functions + deploy/web.wrangler.jsonc together — docs/system/DEPLOY.md §3
```

`deploy/talorys.json` and `deploy/web.wrangler.jsonc` are copies of the installer's manifest and Pages
config (no secrets). Secrets are listed by name in [docs/system/SECRETS.md](docs/system/SECRETS.md).
