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

The installer deploys the published npm package. To ship changes from this repo instead,
build and deploy the two apps with wrangler against the same resource names, so data and URL
stay the same:

1. `npm install && npm run build` (Node 22+; see upstream README / `docs/deployment.md`).
2. Agent: `cd apps/agent && wrangler deploy --name talorys-lxl5w9o0-agent` (keep the Durable
   Object binding/class names identical — a rename would orphan the data; add a migration if
   upstream's `wrangler.jsonc` requires one).
3. Web: `cd apps/web && wrangler pages deploy dist --project-name talorys-lxl5w9o0-web`.
4. Secrets already set on the worker (owner password hash, session secret) are untouched by a
   redeploy. `npx create-talorys@latest doctor` confirms health afterwards.

Known limits of the current build (what we want to improve): small free Workers AI model with a
daily quota, no web access, no email/calendar/WhatsApp integrations, in-app reminders only
(no push), single user. OpenConnector (separate repo) is the planned bridge for integrations.
