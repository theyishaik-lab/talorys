# Talorys system documentation (Yishai's deployment)

Last verified against the live system: **October 13, 2026, 02:45 Israel time** (code, Cloudflare API and
OpenConnector admin API, read-only). Written by Tab.

This folder has two kinds of documents:

1. **System docs (`docs/system/`)** — the whole system as it runs for Yishai: Talorys, OpenConnector,
   the Android app, the Cloudflare account, connections, secrets, deploys. Start here.
2. **Upstream reference docs (`docs/*.md`)** — written by the Talorys authors (rociiu/talorys) and still
   accurate for the internals of Talorys itself.

## System docs — start here

| Document | What it answers |
| --- | --- |
| [ARCHITECTURE.md](system/ARCHITECTURE.md) | What runs where, how the pieces talk, the diagram, the request and approval flows |
| [DEPLOY.md](system/DEPLOY.md) | How to deploy and update each piece safely, local dev, tests |
| [CONNECTIONS.md](system/CONNECTIONS.md) | Which outside services are connected (GitHub, Google, public), how to add one |
| [UI.md](system/UI.md) | Where the front end lives and how to change it, run it and ship it |
| [ANDROID.md](system/ANDROID.md) | The Android app: package, versions, signing key, rebuild |
| [SECRETS.md](system/SECRETS.md) | Every secret and config value by NAME and where it lives (never the values) |
| [MODELS.md](system/MODELS.md) | Which Workers AI chat model is used and why (benchmark), the leak guard, how to re-run the bench |
| [ROADMAP.md](system/ROADMAP.md) | Known issues, limits and what comes next |

## Upstream reference docs

| Document | Topic |
| --- | --- |
| [architecture.md](architecture.md) | Talorys internals: Durable Object, scheduling, tools, data model |
| [deployment.md](deployment.md) | The `create-talorys` installer and generated configs |
| [development.md](development.md) | Local dev processes, ports, scripts, mock AI |
| [openconnector.md](openconnector.md) | The OpenConnector tools added in this fork |
| [memory-history.md](memory-history.md), [semantic-recall.md](semantic-recall.md) | Memory features |
| [security.md](security.md), [troubleshooting.md](troubleshooting.md) | Security model, common problems |

## The one rule to remember

> **Never run plain `npx create-talorys update` on this installation.** It redeploys the published npm
> package over the agent Worker and removes the OpenConnector integration (tools + service binding).
> Deploy from this fork instead — see [system/DEPLOY.md](system/DEPLOY.md).
