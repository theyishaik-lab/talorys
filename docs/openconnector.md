# OpenConnector integration

Talorys can reach external apps (email, calendar, Notion, GitHub, arXiv and ~1,400 more) through
[OpenConnector](https://github.com/theyishaik-lab/open-connector), an auth gateway that holds the
app credentials and exposes their actions over MCP. Talorys never sees a credential: it holds one
OpenConnector *runtime token* and asks the connector to run actions.

## What the agent gets

Five tools, appended to the upstream set by `apps/agent/src/openconnector/`:

| Tool | Permission | What it does |
| --- | --- | --- |
| `connected_apps` | read | Which accounts are connected, which public services work without a login |
| `search_actions` | read | Finds action ids in the catalog (`gmail.search_threads`, `notion.create_page`, …) |
| `action_guide` | read | The exact input parameters of one action |
| `run_action` | read | Runs an action whose name starts with a read verb (get/list/search/fetch/find/read/query/…) |
| `propose_action` | destructive | Anything that sends, creates, edits or deletes. It only proposes; the owner taps **Approve** in the chat, then it runs once. The result lands in the notification bell. |

`run_action` refuses non-read actions and points the model at `propose_action`, so no change in an
outside account ever happens without the owner's approval. Scheduled runs only see the read tools
(upstream rule). Tool results are cut at 3,500 characters before they reach the model.

When the connector is configured the system prompt swaps the upstream "you cannot send email or
access accounts" rule for a short description of the tools (`CONNECTOR_RULE` in `agent/prompt.ts`).
`DEFAULT_LIMITS` were raised to 10 tool calls / 8 steps per request, since a discovery flow takes
three or four calls; existing installs keep their stored limits (change them in Settings → AI).

## Configuration

The tools are off unless the Worker has:

- `OPEN_CONNECTOR_TOKEN` — a Worker **secret** holding an OpenConnector runtime token
  (`wrangler secret put OPEN_CONNECTOR_TOKEN`). Never put it in `vars` or in git.
- and either a service binding `OPEN_CONNECTOR` to the connector Worker in the same account
  (`"services": [{ "binding": "OPEN_CONNECTOR", "service": "open-connector" }]`, the production
  setup in `deploy/agent.wrangler.jsonc`) or the var `OPEN_CONNECTOR_URL` with its public URL.

The connector's MCP endpoint is `POST /mcp` (stateless JSON-RPC; see its `docs/runtime-api.md`).

## Connecting apps

Apps are connected in the OpenConnector web console (admin token), not in Talorys. API-key apps
(Notion, Todoist, Linear, GitHub PAT) take a key; OAuth apps (Gmail, Google Calendar, Slack,
Outlook…) need an OAuth app registered with the provider whose redirect is
`<connector-url>/oauth/callback`. Until an app is connected its actions report `ready: false` and
an approved run fails with the connector's message ("Connect gmail with OAuth first").

## Model notes

With the free `@cf/zai-org/glm-4.7-flash` the flow works for single-action requests in English and
Hebrew (verified live: "which apps are connected", an arXiv fetch, a send-email proposal). The model
sometimes guesses an action's input before reading its guide and recovers after the error, which is
why the step limits were raised. Multi-step requests across several apps are not reliable on it.
