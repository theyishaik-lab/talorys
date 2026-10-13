# Connected services

Talorys reaches outside apps only through OpenConnector. A service is usable when OpenConnector has a
**connection** for it (an API key or an OAuth grant) — or when the provider needs no login at all.
Talorys itself never holds an outside credential.

Status as read from OpenConnector's admin API on **Oct 13, 2026, 02:45 IL**:

| Service | Status | Account | How it is connected |
| --- | --- | --- | --- |
| GitHub | ✅ connected, verified | `theyishaik-lab` | `api_key` connection `default` holding the theyishaik-lab OAuth token (scopes repo, workflow, read:org, gist). Verified Oct 13: `github.list_my_repositories` returned talorys, talorys-android, open-connector; Talorys answered the same in Hebrew in live chat. |
| Gmail | 🟡 in progress | theyishaik@gmail.com | Google OAuth — see below |
| Google Calendar | 🟡 in progress | theyishaik@gmail.com | Google OAuth — see below |
| Google Drive | 🟡 in progress | theyishaik@gmail.com | Google OAuth — see below |
| 20 public providers | ✅ work without login | — | built in (`no_auth`) |

Never connect or write to Yishai's personal GitHub account `yishaik`.

## Public providers that work without any login

arxiv · biorxiv_medrxiv · clinicaltrials_gov · crossref · datacite · dealnews · docsend_2_pdf ·
europe_pmc · fundzwatch · hackernews · indiegogo · linux_do · npm · openfda · openfootball_worldcup ·
ossinsight · pubmed · quickchart (charts) · who_gho · wttr_in (weather)

## Google (Gmail, Calendar, Drive) — IN PROGRESS

> **Update this section when the setup finishes** (date, which services connected, how verified).

What exists so far (Oct 13, 2026, ~02:45 IL):

- Google account: **theyishaik@gmail.com** (Yishai's project account).
- Google Cloud project **`talorys-connector`** (no billing).
- OAuth consent screen ("Google Auth Platform"): app name **Talorys**, audience **External**,
  **published to production** (so refresh tokens do not expire after 7 days). The app is *unverified*,
  which only means a warning screen at consent time.
- APIs enabled: Gmail API, Google Calendar API, Google Drive API (Docs, Sheets and Tasks: to confirm
  when the setup finishes).
- One OAuth client of type **Web application**, authorized redirect URI
  `https://open-connector.yishai-kaminsky.workers.dev/oauth/callback`. Its client id/secret are stored
  in OpenConnector (encrypted) for **gmail, googlecalendar, googledrive, googledocs, googlesheets,
  googletasks** (verified in the admin API), and in Tab's secret store — never in git.
- Remaining: the consent grant for each service (Gmail first, then Calendar and Drive — Google asks
  Yishai for a fresh security code from his phone on this step), then a real read to verify (latest
  email subject, today's events, a Drive file list). No Google connection exists yet.

### How Google works in OpenConnector

- Every Google product is its **own provider** with its own OAuth-client slot: `gmail`,
  `googlecalendar`, `googledrive`, `googledocs`, `googlesheets`, `googleslides`, `googletasks`,
  `googlephotos`, `googleforms`, `googlechat`, `googlemeet`, `youtube`, … One Google Cloud OAuth
  client can be pasted into all of them.
- Store the client for a service (admin token):
  `PUT /api/oauth/configs/<service>` with `{"clientId": "...", "clientSecret": "..."}`.
- Start a consent for a service: `POST /api/oauth/authorizations` with `{"service": "gmail"}` → returns
  an `authorizationUrl`. Open it signed in as theyishaik@gmail.com → "Google hasn't verified this app"
  → **Advanced → Go to Talorys (unsafe)** → tick every box → **Allow**. Google redirects to
  `/oauth/callback` and OpenConnector stores the tokens.
- Gmail asks for restricted scopes (`gmail.modify`, `gmail.labels`, `gmail.settings.basic`, …), which is
  why the unverified-app warning appears. For a personal app with one user that is expected.
- To add another Google product later (Docs, Sheets, Tasks…): enable its API in the
  `talorys-connector` project, store the same client for that service, run its consent.
- Mail-only alternative OpenConnector also supports: the generic **IMAP mailbox** provider with a Gmail
  App Password. Not used — OAuth covers mail, calendar and files at once.

## Adding a new connection (manual, today)

All through OpenConnector — the web console at https://open-connector.yishai-kaminsky.workers.dev
(unlock with the admin token) or its admin API with `Authorization: Bearer <admin token>`.

**API-key services** (Notion, Todoist, Linear, GitHub PAT, …):

```bash
curl -X PUT https://open-connector.yishai-kaminsky.workers.dev/api/connections/<service> \
  -H "Authorization: Bearer $OC_ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"authType":"api_key","values":{"apiKey":"..."}}'
```

**OAuth services** (Google, Slack, Spotify, Dropbox, Outlook, …): first register an OAuth app *with the
provider* whose redirect URI is `https://open-connector.yishai-kaminsky.workers.dev/oauth/callback`,
store its client id/secret with `PUT /api/oauth/configs/<service>`, then run the consent link from
`POST /api/oauth/authorizations`. `GET /api/oauth/configs` lists all 100 OAuth providers with the
redirect URI each one expects.

**Check it from Talorys:** ask "which apps are connected?" (`connected_apps`), then a read request.
Until a service is connected, its actions show `ready: false` and an approved run fails with
OpenConnector's message ("Connect gmail with OAuth first").

## What the agent can and cannot do with a connection

- Read actions run immediately (`run_action`).
- Anything that sends, creates, edits or deletes needs Yishai's tap on **Approve** in the chat
  (`propose_action`); the result appears in the bell.
- Automations (scheduled runs) can only read.
- Since Oct 13, 2026 the agent can **connect a new app from the chat** ("תחבר לי את Google Tasks" /
  "connect Notion"): see "Connecting an app from the chat" below.

## Connecting an app from the chat (agent self-connect)

Tools `list_connectable_services` (which apps can be connected, Hebrew and English names, which are
already connected) and `connect_service(service)` in `apps/agent/src/openconnector/connect.ts`.
`connect_service` is a *destructive* tool, so it only proposes: a **connect card** appears in the chat
and nothing happens until Yishai taps **אישור / Approve**.

- **OAuth apps whose client is stored in OpenConnector** (today every Google service: Gmail, Calendar,
  Drive, Docs, Sheets, Tasks): after Approve the agent Worker asks OpenConnector for a consent link
  (`POST /api/oauth/authorizations`) and the card shows a **Sign in to …** button. Yishai taps it, consents
  in the browser, comes back; the card polls `GET /api/connections/:service` and turns into "connected".
  The link is refreshed every time the card is shown (`POST /api/actions/:id/link`) because
  OpenConnector's OAuth state lives 15 minutes. New Google APIs (Docs, Sheets, Tasks…) must also be
  enabled in the `talorys-connector` Cloud project or the first action answers 403.
- **API-key / custom-credential apps** (Notion, Todoist, Linear, Trello, OpenAI, …): the card shows
  the provider's secret fields (label, placeholder and hint come from the catalog). The typed value
  goes in the body of `POST /api/actions/:id/approve` straight to `PUT /api/connections/:service` on
  OpenConnector, which validates it against the provider. Talorys never stores, logs or echoes it,
  and the model never sees it (the tool result only says a card was shown). A rejected key marks the
  card failed with OpenConnector's reason; a new proposal is one message away.
- **OAuth apps without a registered client** (Slack, Spotify, Dropbox, Outlook…): the tool answers
  "needs a one-time setup" and the agent says so; nothing is attempted. Registering the provider app
  and storing its client id/secret (`PUT /api/oauth/configs/:service`) is Tab's job.
- The OpenConnector **admin token** is the Worker secret `OPEN_CONNECTOR_ADMIN_TOKEN`; only the
  server-side commit after the approval (and the catalog lookups in `prepare`) use it. It is never in
  a tool result or a prompt. Without the secret the two tools are not registered.
- Card strings are Hebrew/English per the UI locale (`apps/web/src/components/ConnectCard.tsx`).
