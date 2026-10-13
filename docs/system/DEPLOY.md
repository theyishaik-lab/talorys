# Deploy, update, develop

> ⚠️ **Never run plain `npx create-talorys update` (or `create-talorys@latest update`) on this
> installation.** The installer deploys the *published npm package*: it overwrites the agent Worker
> with code that has no OpenConnector tools and a generated config with no `OPEN_CONNECTOR` service
> binding. Data survives, the connector integration does not. Always deploy from this fork. If it ever
> happens by accident: redeploy the agent from `main` (section 2) and everything comes back — the
> `OPEN_CONNECTOR_TOKEN` secret is not removed by a deploy.

Everything below runs from a clone of `theyishaik-lab/talorys` (`main`) with Node.js 22+ and a
Cloudflare API token for the account in `CLOUDFLARE_API_TOKEN` (the token named `talorys-deploy`;
see SECRETS.md). Account id `25e3dffccdb99cd3801798bcc4a5b54a`.

## 1. Before every deploy

```bash
npm install
npm run typecheck
npm test -w @talorys/agent      # 282 tests, ~40 s (runs inside workerd)
npm test -w @talorys/web        # when apps/web changed
```

## 2. Deploy the agent Worker (`talorys-lxl5w9o0-agent`)

```bash
export CLOUDFLARE_API_TOKEN=...            # talorys-deploy
npx wrangler deploy --config deploy/agent.wrangler.jsonc
```

- `deploy/agent.wrangler.jsonc` is the production config: same Worker name, Durable Object binding and
  class (`TalorysAgent`), migration tag `v1`, the `AI` binding and the `OPEN_CONNECTOR` service
  binding. A deploy keeps all data, the URL and every logged-in session.
- Secrets (`OWNER_PASSWORD_HASH`, `SESSION_SECRET`, `OPEN_CONNECTOR_TOKEN`, `OPEN_CONNECTOR_ADMIN_TOKEN`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, `FCM_SERVICE_ACCOUNT` for the native app's notifications) live on the Worker and are
  untouched by a deploy. Set or replace one with `npx wrangler secret put NAME --config deploy/agent.wrangler.jsonc`.
- **Never rename** the Durable Object binding or class and never add a DO migration — that would
  orphan the database. Schema changes go into `apps/agent/src/db/migrations.ts` (append-only); they run
  automatically on first use after the deploy.
- Bump `TALORYS_DEPLOYED_VERSION` in the config when you ship something notable (now `0.1.6-push`).
- Bundle: ~632 KiB gzip (`npx wrangler deploy --dry-run --outdir /tmp/x --config deploy/agent.wrangler.jsonc`), far under the 3 MiB free limit.

Check: `curl https://talorys-lxl5w9o0-web.pages.dev/api/health` → `"ok":true`; after login,
`/api/system` shows `deployed_version`.

## 3. Deploy the web app (Pages project `talorys-lxl5w9o0-web`)

Needed only when `apps/web` changed. Android picks the change up automatically (the app loads the live
site), so no APK rebuild is needed for UI work.

The build also writes `dist/sw.js` (the service worker, see NOTIFICATIONS.md) with a hash of this
build: every deploy installs a new worker on the phones and drops the old shell cache. If the build
fails, no `sw.js` is written — never deploy a `dist/` from a failed build. The build ends with the
bundle-size budget (`apps/web/scripts/bundle-budget.mjs`; initial JS ≤ 200 KB gzip) and fails when a
change busts it — raise the budget in that file only on purpose. An installed app that is open while
you deploy keeps the old build until it goes to the background, then reloads itself (UI.md, "Native
feel and performance").

The Pages deploy must contain **three things side by side**: the built `dist/`, the `functions/`
folder (the `/api` proxy — without it every API call 404s and the app breaks), and a `wrangler.jsonc`
whose `AGENT` service binding points at `talorys-lxl5w9o0-agent`. `apps/web/wrangler.jsonc` is the
*local dev* config (binds to `talorys-dev-agent`) — do not deploy with it. Use a staging folder, the
same layout the installer used:

```bash
npm run build -w @talorys/web                          # -> apps/web/dist
rm -rf /tmp/talorys-web && mkdir -p /tmp/talorys-web
cp -r apps/web/dist apps/web/functions /tmp/talorys-web/
cp deploy/web.wrangler.jsonc /tmp/talorys-web/wrangler.jsonc
cd /tmp/talorys-web
npx wrangler pages deploy dist --project-name talorys-lxl5w9o0-web --branch main
```

Then open the site, sign in, send one chat message, and check the bell. For the app shell: `/sw.js`
and `/manifest.webmanifest` must answer 200 with `cache-control: no-cache`, and Settings → Device
notifications → "Send test notification" must arrive on a subscribed phone. Rolling back: Cloudflare
dashboard → Workers & Pages → `talorys-lxl5w9o0-web` → Deployments → "Rollback" on the previous one.

> Status (Oct 13, 2026, 03:13 IL): the procedure above was run for the first time (preview branch
> first, then `main`) and verified — `/api/health`, login, `/api/auth/session`, a streamed chat reply
> and the bell all worked on the new deploy. The live web is now the fork's `main` build, which also
> brought upstream's "AI usage today" popover (`980331b`) and the repository links in the UI
> (sidebar footer, login footer, Settings → About).

## 4. Deploy OpenConnector (Worker `open-connector`)

From a clone of `theyishaik-lab/open-connector` `main` with a `wrangler.local.jsonc` (git-ignored; it
holds only resource ids, no secrets):

```jsonc
{
  "name": "open-connector",
  "main": "src/server/cloudflare.ts",
  "compatibility_date": "2026-07-02",
  "compatibility_flags": ["nodejs_compat"],
  "cache": { "enabled": true },
  "assets": {
    "directory": "dist/web", "binding": "ASSETS", "not_found_handling": "single-page-application",
    "run_worker_first": ["/api/*", "/v1/*", "/mcp*", "/oauth/*",
                         "/docs", "/docs/*", "/openapi.json", "/health"]
  },
  "d1_databases": [{ "binding": "DB", "database_name": "open-connector",
                     "database_id": "c863dd83-3ef8-4c32-9fd2-4b0edb9f8cf1", "migrations_dir": "migrations" }],
  "kv_namespaces": [{ "binding": "TRANSIT_FILES", "id": "66d3bf473d4949e1b50d8bfc4a3983f5" }],
  "vars": { "TRANSIT_FILES_BACKEND": "kv" },
  "observability": { "enabled": true,
                     "logs": { "enabled": true, "invocation_logs": true, "persist": true } }
}
```

```bash
export CLOUDFLARE_API_TOKEN=...            # openconnector-deploy
export CLOUDFLARE_ACCOUNT_ID=25e3dffccdb99cd3801798bcc4a5b54a
npx wrangler d1 migrations apply open-connector --remote --config wrangler.local.jsonc   # on upgrades
npm run deploy:cloudflare
curl https://open-connector.yishai-kaminsky.workers.dev/health   # {"ok":true}
```

- Watch the size line: **3,034 KiB gzip of the 3,072 KiB free limit** (web console assets are uploaded
  separately and do not count — a console-only change leaves it unchanged, verified Oct 13, 2026). An upstream merge that adds
  providers can push it over; the fix is excluding unused providers from the Cloudflare bundle (the way
  Aliyun OSS, MQTT and Postman already are) or a paid plan.
- Merging upstream (`upstream-main`, 330 commits ahead) needs conflict resolution in the action runner,
  connect server and storage (the per-account-grants commit touches them) plus the size check.
- **Never change `OOMOL_CONNECT_ENCRYPTION_KEY`** — every stored credential is encrypted with it.
- The service binding from Talorys refers to the Worker *name* `open-connector`; keep the name.

## 5. Installer day-2 commands that ARE safe

From the installer folder (on Tab's machine; it holds `talorys.json`) with `CLOUDFLARE_API_TOKEN`:

| Command | Safe? | Note |
| --- | --- | --- |
| `npx create-talorys@latest status` | yes | read-only |
| `npx create-talorys@latest doctor` | yes | read-only checks |
| `npx create-talorys@latest reset-password` | yes | only replaces the `OWNER_PASSWORD_HASH` secret |
| `npx create-talorys@latest update` | **NO** | overwrites the agent — see the warning at the top |

## 6. Local development

```bash
npm install
npm run dev          # agent :8787 (wrangler dev --local), Pages function :8788, Vite UI :5173
```

Open http://localhost:5173. `scripts/dev-setup.mjs` writes `apps/agent/.dev.vars` (git-ignored) with
the **mock AI** (deterministic, offline), a local password and session secret; set
`TALORYS_DEV_PASSWORD=...` before the first run to choose the password. Local data lives in
`.wrangler/state`.

- Real model locally: `npx wrangler login`, then `npm run dev:remote-ai -w @talorys/agent` instead of
  `dev:agent` (uses the account's Workers AI quota).
- OpenConnector tools locally: add to `apps/agent/.dev.vars`
  `OPEN_CONNECTOR_URL=https://open-connector.yishai-kaminsky.workers.dev` and
  `OPEN_CONNECTOR_TOKEN=<runtime token>` (keep it out of git; `.dev.vars` is ignored).

## 7. Tests

| Command | What |
| --- | --- |
| `npm test` | all workspaces (shared, agent in workerd, web, installer) |
| `npm test -w @talorys/agent` | agent incl. `openconnector.test.ts` + `leak-guard.test.ts` — 282 passing on Oct 13, 2026 |
| `npm run test:e2e` | Playwright UI tests on an isolated local stack (`tests/e2e/`) |
| `npm run typecheck` / `npm run lint` | TypeScript / Biome |

## 8. Keeping up with upstream Talorys

```bash
git fetch upstream
git merge upstream/main          # resolve conflicts, keep apps/agent/src/openconnector and deploy/
npm test -w @talorys/agent
```

Files this fork changes relative to upstream (expect conflicts only here):
`apps/agent/src/openconnector/*` (new), `agent/prompt.ts` (`CONNECTOR_RULE`), `agent/runner.ts`,
`agent/talorys-agent.ts`, `api/routes/chat.ts` (approval uses the connector tool set), `env.ts`,
`semantic/hooks.ts`, `packages/shared/src/constants.ts` (`DEFAULT_LIMITS` 10 tool calls / 8 steps),
tests `agent.test.ts` + `openconnector.test.ts`, `DEPLOY.md`, `deploy/`, `docs/`.


## 5. The native Android app

Built locally from `apps/mobile` (`scripts/build-apk.sh`); not deployed anywhere — the APK is sent
to the phone. Steps, signing, Firebase setup and versioning: `docs/system/MOBILE.md`. A web deploy
does **not** update the app; a new APK does.
