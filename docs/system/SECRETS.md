# Secrets and configuration — names and locations only

This file lists **names and where each value lives. No value appears here or anywhere in git.** If
you ever need one, ask Tab; it travels privately.

"Tab's secret store" means files on Tab's private machine that only Tab reads (mode 600):
`state/talorys-secrets.json`, `state/openconnector-secrets.json`, `state/github-project-secrets.json`,
`state/talorys-mobile-keystore/`, `state/talorys-firebase/`. Saved website logins sit in Tab's encrypted login vault.

## Cloudflare account

| Name | What | Where it lives |
| --- | --- | --- |
| Account login (email `yishai.kaminsky@mail.tab.bot` + password) | Dashboard login; the email is Tab's mailbox for Yishai, so Cloudflare mail lands with Tab | Tab's secret store (`talorys-secrets.json`) |
| Account id `25e3dffccdb99cd3801798bcc4a5b54a` | Not secret | here, `deploy/talorys.json` |
| API token **`talorys-deploy`** | Workers Scripts edit, Cloudflare Pages, Workers AI, account settings + user details read — deploys Talorys | Tab's secret store (`talorys-secrets.json`) |
| API token **`openconnector-deploy`** | Workers Scripts, D1, Workers KV edit + account settings / user details read — deploys OpenConnector (cannot touch Pages) | Tab's secret store (`openconnector-secrets.json`) |
| workers.dev subdomain `yishai-kaminsky` | Not secret | Cloudflare |

## Talorys agent Worker (`talorys-lxl5w9o0-agent`)

| Name | Type | What | Where |
| --- | --- | --- | --- |
| `OWNER_PASSWORD_HASH` | Worker secret | PBKDF2 hash of the owner password | Cloudflare (reset with `create-talorys reset-password`) |
| `SESSION_SECRET` | Worker secret | Keys the session-token hashes; changing it signs out every device | Cloudflare |
| `OPEN_CONNECTOR_TOKEN` | Worker secret | OpenConnector runtime token (same value as `OOMOL_CONNECT_RUNTIME_TOKEN`) | Cloudflare + Tab's secret store (`openconnector-secrets.json`, `runtime_token`) |
| `OPEN_CONNECTOR_ADMIN_TOKEN` | Worker secret | OpenConnector admin token; only the server-side connect step uses it (CONNECTIONS.md) | Cloudflare + Tab's secret store (`openconnector-secrets.json`, `admin_token`) |
| `FCM_SERVICE_ACCOUNT` | Worker secret | The Firebase service-account JSON (verbatim) the agent signs FCM HTTP v1 requests with, for the native Android app's notifications (MOBILE.md, NOTIFICATIONS.md). Role: Firebase Cloud Messaging API Admin, nothing else. Revoke from Google Cloud IAM if leaked | Cloudflare + Tab's box (`talorys-secrets.json` → `firebase_project` names the key file under `state/talorys-firebase/`; set Oct 13, 2026, project `talorys-app`) |
| Android release keystore | Tab's box only | Signs the native APK (`/home/user/tab/state/talorys-mobile-keystore/talorys-release.jks`, alias `talorys`); password in `talorys-secrets.json` → `mobile_keystore`. Losing it means the installed app cannot be updated in place | Tab's box |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Worker secrets | Web Push signing keys (one P-256 pair per install) and the `mailto:` contact push services see — set Oct 13, 2026 (NOTIFICATIONS.md). The public key is not secret (every browser gets it); the private key must never be rotated casually, every device would have to re-enable notifications | Cloudflare + Tab's secret store (`talorys-secrets.json`, `vapid_*`) |
| Provider API keys (Gemini, OpenRouter) | agent DB, encrypted | Set in Settings → Model; checked with the provider before saving; only the last 4 characters are ever returned. Gemini key created Oct 13, 2026 in Yishai's AI Studio (project "Default Gemini Project", free tier) | Agent DB + Tab's secret store (`talorys-secrets.json`, `gemini_api_key`) |
| Owner password (plain) | — | What Yishai types to sign in. Changing it in the app (Settings → Security → Change password) signs out other devices; tell Tab so its copy stays right | Yishai + Tab's secret store (`talorys-secrets.json`) |
| `AI` | binding | Workers AI | `deploy/agent.wrangler.jsonc` |
| `TalorysAgent` | DO binding | the database | `deploy/agent.wrangler.jsonc` |
| `OPEN_CONNECTOR` | service binding → `open-connector` | | `deploy/agent.wrangler.jsonc` |
| `TALORYS_INSTALLATION_ID`, `TALORYS_DEPLOYED_VERSION`, `TALORYS_DEFAULT_TIMEZONE`, `TALORYS_AGENT_NAME` | vars | informational / first-run defaults | `deploy/agent.wrangler.jsonc` |
| `OPEN_CONNECTOR_URL` | var | connector URL (production uses it: calls go over the public URL; the admin API needs it too) | `deploy/agent.wrangler.jsonc` |
| `TALORYS_ENV`, `TALORYS_MOCK_AI`, `TALORYS_DEV_ORIGINS`, `OWNER_PASSWORD` | dev / one-Worker deploys only | never set in production | `apps/agent/.dev.vars` (git-ignored) |

Session cookie name: `__Host-talorys_session` (30 days). CSRF header: `x-talorys-request: 1`.

## Talorys web (Pages `talorys-lxl5w9o0-web`)

No secrets. One service binding `AGENT` → `talorys-lxl5w9o0-agent` (`deploy/web.wrangler.jsonc`).

## OpenConnector Worker (`open-connector`)

| Name | Type | What | Where |
| --- | --- | --- | --- |
| `OOMOL_CONNECT_ADMIN_TOKEN` | Worker secret | Unlocks the web console and the admin API (`/api/*`) | Cloudflare + Tab's secret store (`admin_token`) |
| `OOMOL_CONNECT_RUNTIME_TOKEN` | Worker secret | Lets callers run actions (`/mcp`, `/v1`); without it those endpoints would be open | Cloudflare + Tab's secret store (`runtime_token`) |
| `OOMOL_CONNECT_ENCRYPTION_KEY` | Worker secret | Encrypts every stored credential and OAuth client in D1. **Losing or changing it makes all connections unrecoverable** | Cloudflare + Tab's secret store (`encryption_key`) |
| `DB` | D1 binding | database `open-connector` (`c863dd83-3ef8-4c32-9fd2-4b0edb9f8cf1`) | `wrangler.local.jsonc` |
| `TRANSIT_FILES` | KV binding | `open-connector-transit-files` (`66d3bf473d4949e1b50d8bfc4a3983f5`) | `wrangler.local.jsonc` |
| `TRANSIT_FILES_BACKEND` | var | `kv` | `wrangler.local.jsonc` |
| `ASSETS` | assets binding | the console's static files | `wrangler.local.jsonc` |

## Credentials stored *inside* OpenConnector (encrypted in D1)

| Connection | What is stored | Other copy |
| --- | --- | --- |
| `github` / `default` (api_key) | theyishaik-lab GitHub OAuth token | Tab's secret store (`github-project-secrets.json`) and the `gh` CLI config on Tab's machine |
| Google OAuth client (gmail, googlecalendar, googledrive, googledocs, googlesheets, googletasks) | client id + client secret of the `talorys-connector` Web client | Tab's secret store (`openconnector-secrets.json`, `google_oauth`) |
| Google grants (after consent) | refresh/access tokens per service | none — only OpenConnector |

## Accounts

| Account | Used for | Where the login lives |
| --- | --- | --- |
| GitHub **theyishaik-lab** | the repos (`talorys`, `open-connector`), OpenConnector GitHub connection | Yishai signs in with Google; Tab holds an OAuth token (device flow, scopes repo/workflow/read:org/gist) |
| GitHub **yishaik** (personal) | **not used — never write here** | — |
| Google **theyishaik@gmail.com** | Cloud project `talorys-connector`, Gmail/Calendar/Drive | Yishai; a copy saved by him in Tab's login vault (Oct 13) for the Cloud Console setup |

## Android signing

| Name | Where |
| --- | --- |
| `talorys-release.jks` (alias `talorys`) for `dev.talorys.app` | Tab's secret store (`state/talorys-mobile-keystore/`, `env.sh` beside it); passwords in `talorys-secrets.json` → `mobile_keystore` — never in git. Every update must be signed with it (MOBILE.md) |
| `google-services.json`, FCM service-account key | Tab's secret store (`state/talorys-firebase/`); copied to `apps/mobile/google-services.json` (gitignored) at build time |

The old WebView APK (`bot.tab.talorys.yishai`) and its keystore were deleted on Oct 13, 2026, after
the native app was confirmed on Yishai's phone.

## Git hygiene

`.gitignore` already excludes `.dev.vars`, `.env*`, `.wrangler/`. Before every commit:

```bash
git diff --cached | grep -nE "cfut_|gho_|ghp_|github_pat_|BEGIN .*PRIVATE KEY|client_secret|GOCSPX-" && echo "STOP: secret in diff"
```

**Note:** `theyishaik-lab/talorys` and `theyishaik-lab/open-connector` are **public** repositories.
They contain no secrets, but they do show the live URLs and resource ids. Make them private on GitHub
(Settings → Danger zone → Change visibility) if you prefer.
