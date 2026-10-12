# Yishai's deployment (notes by Tab, Oct 12, 2026)

This fork tracks upstream [rociiu/talorys](https://github.com/rociiu/talorys). Yishai's live
instance was installed from the published installer, not from this fork (yet):

- URL: https://talorys-lxl5w9o0-web.pages.dev
- Talorys version: 0.1.5 · installation id `lxl5w9o0`
- Cloudflare account: `25e3dffccdb99cd3801798bcc4a5b54a` (free plan, no card). Account email is
  Tab's mailbox for Yishai; the account password and the deploy API token are kept on Tab's box
  (`state/talorys-secrets.json`), never in this repo.
- Agent Worker (private): `talorys-lxl5w9o0-agent` — SQLite Durable Object, Workers AI model
  `@cf/zai-org/glm-4.7-flash`; workers.dev subdomain `yishai-kaminsky`
- Pages project: `talorys-lxl5w9o0-web`
- App timezone: `Asia/Jerusalem`
- Android app: separate repo `talorys-android`

`deploy/talorys.json` and `deploy/web.wrangler.jsonc` are copies of the installer's manifest
(no secrets) so the deployment can be found again from here.

## Day-2 commands (from the installer directory on Tab's box, `files/talorys/talorys`)

```bash
export CLOUDFLARE_API_TOKEN=…   # from state/talorys-secrets.json
npx create-talorys@latest status
npx create-talorys@latest update          # upgrade to latest published version, keeps data
npx create-talorys@latest doctor
npx create-talorys@latest reset-password  # new owner password
```

## Deploying THIS fork (for the upgrades we build here)

The installer deploys the published npm package. Since Oct 13, 2026 the live agent Worker is
deployed from this repo instead, with `deploy/agent.wrangler.jsonc` (same Worker name, Durable
Object binding/class and migration tag as the installer's config, so data, URL and sessions stay):

1. `npm install` (Node 22+), then `npm run typecheck` and `npm test -w @talorys/agent`.
2. Agent: `export CLOUDFLARE_API_TOKEN=…` and
   `npx wrangler deploy --config deploy/agent.wrangler.jsonc`.
   Secrets already on the Worker (owner password hash, session secret, `OPEN_CONNECTOR_TOKEN`) are
   untouched by a redeploy. Never rename the Durable Object binding or class — that would orphan
   the data; a schema change goes through `apps/agent/src/db/migrations.ts`, not a DO migration.
3. Web (only when `apps/web` changed): `npm run build -w @talorys/web`, then
   `npx wrangler pages deploy apps/web/dist --project-name talorys-lxl5w9o0-web`.
4. `/api/health` and `/api/system` (`deployed_version`) confirm the deploy.

Running `npx create-talorys@latest update` again would overwrite the agent with the published
package (losing the OpenConnector tools and the service binding) — redeploy from here afterwards.

## OpenConnector

Yishai's OpenConnector runs as the Worker `open-connector` in the same account
(https://open-connector.yishai-kaminsky.workers.dev, console = same URL, admin token). The agent
reaches it through the `OPEN_CONNECTOR` service binding plus the `OPEN_CONNECTOR_TOKEN` secret
(a runtime token). See `docs/openconnector.md`.

Known limits of the current build (what we want to improve): small free Workers AI model with a
daily quota, in-app reminders only (no push), single user. External apps are reachable through
OpenConnector once connected in its console (`docs/openconnector.md`); no WhatsApp.
