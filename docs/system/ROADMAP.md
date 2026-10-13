# Known issues, limits and roadmap

## Known issues and limits (Oct 13, 2026)

| # | Issue | Impact | Fix / workaround |
| --- | --- | --- | --- |
| 1 | **OpenConnector bundle 3,034 KiB of the 3,072 KiB free-plan limit** | The next upstream merge may not deploy on the free plan | Exclude unused providers from the Cloudflare bundle; or Workers Paid ($5/month, 10 MiB) |
| 2 | **Weak free model** (`glm-4.7-flash`) | Fine for one-step requests in English and Hebrew; unreliable for multi-step flows across apps and sometimes in Hebrew (answers without calling tools, or guesses an action's input before reading its guide, then recovers) | Raised limits to 10 tool calls / 8 steps. Real fix: a stronger model (needs a provider/API key, see below) or direct per-app tools that skip catalog discovery |
| 3 | **Google app is unverified** | Consent shows "Google hasn't verified this app" → Advanced → Go to Talorys | Expected for a personal app; verification is only needed for other users |
| 4 | **Google setup in progress** | Gmail/Calendar/Drive not usable yet | See CONNECTIONS.md |
| 5 | **Live web lags `main`** | The "AI usage today" popover (upstream `980331b`) is on `main` but not live | Next web deploy from the fork (DEPLOY.md §3) |
| 6 | ~~No right-to-left support in the UI~~ | **Done Oct 13, 2026** (`9b41c85`): Hebrew locale + RTL layout, Settings → General → Language | Remaining: translate the Memory/Tasks/Notes/Automations pages and the other Settings tabs — UI.md → "Hebrew / right-to-left" |
| 7 | **No push notifications** | Results of approved actions and reminders appear only in the bell while the app is open | Web Push or FCM in the Android app (below) |
| 8 | **Daily AI budget** | 200 AI requests/day (Talorys) and the Workers AI free Neuron allocation; when it runs out the chat stops answering until the next UTC day (03:00 Israel time in summer, 02:00 in winter) | Settings → AI; the usage popover after the web deploy |
| 9 | **Single runtime token with full access** | Talorys's runtime token can run any action on any connection (writes still need Yishai's Approve) | Create a scoped key in OpenConnector's Access page (per-service / per-action grants, from Yishai's grants commit) and swap `OPEN_CONNECTOR_TOKEN` |
| 10 | **Installer `update` is a trap** | Overwrites the connector integration | Never run it; deploy from the fork |
| 11 | **Upstream OpenConnector is 330 commits ahead** | Missing newer providers/fixes | Merge `upstream-main` with conflict resolution + size check |
| 12 | **`/api/health` says `0.1.5`** | It reports the shared constant; the real deploy marker is `deployed_version` (`0.1.5-openconnector`) in `/api/system` | Cosmetic |
| 13 | **Worker var `TALORYS_DEFAULT_TIMEZONE` = `UTC`** | Only the first-run default; the app setting is `Asia/Jerusalem` and wins | Cosmetic; could set the var to `Asia/Jerusalem` on the next agent deploy |
| 14 | **Android app untested on a real device by Tab** | — | Feedback from Yishai's phone |
| 15 | **Public repos** | URLs and resource ids visible (no secrets) | Make repos private if preferred |

## Next: the agent adds connections itself

Agreed with Yishai on Oct 13, 2026. Goal: "connect Notion" in the chat is enough.

1. **API-key services** (Notion, Todoist, Linear, OpenAI, …): a new tool `connect_service` asks Yishai
   for the key in the chat, then *proposes* the connection — the same Approve card as other changes.
   On approval the agent stores it in OpenConnector. The admin token is **not** given to the agent:
   either a narrow server-side route in the agent Worker that can only create/replace a connection, or
   an OpenConnector key scoped to connection management. The key should not stay in the chat history
   (mask it after use).
2. **Google services** (Docs, Sheets, Tasks, Photos, YouTube…): the OAuth client already exists; the
   agent enables nothing itself, but asks OpenConnector for a consent link
   (`POST /api/oauth/authorizations`) and shows it as a button in the chat. Yishai taps, approves,
   done. New Google APIs must first be enabled in the `talorys-connector` Cloud project (Tab does it).
3. **Providers that need their own OAuth app** (Slack, Spotify, Dropbox, Outlook/Microsoft, …): one-time
   app registration with the provider is done by Tab; after that they behave like case 2.
4. UI: a "Connections" page in Settings listing what is connected, with Connect / Disconnect.

## Later ideas

- **UI work** (Yishai, next): layout and look (redesign/rebrand) — RTL is in; see UI.md.
- **Stronger model**: an `AIProvider` for an external API (OpenRouter, Gemini, Anthropic, OpenAI) next
  to Workers AI, selected in `TalorysAgent.aiProvider()` and Settings. Needs an API key (paid or a free
  tier) as a Worker secret.
- **Push notifications**: Web Push from the agent Worker (VAPID keys as secrets) and/or Firebase Cloud
  Messaging in the Android app.
- **Scoped runtime token** for Talorys (issue 9).
- **Deploy automation**: a GitHub Actions workflow on `theyishaik-lab/talorys` that runs tests and
  deploys agent + web on push to `main` (needs `CLOUDFLARE_API_TOKEN` as a repository secret).
- **Android 1.1**: pull-to-refresh, push, Play-store-ready signing if ever published.
