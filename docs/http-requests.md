# HTTP requests / REST APIs (`http_request`)

The agent can call REST/HTTP APIs on the public internet with the `http_request` tool, and the
owner keeps API keys as saved **API connections** (Settings → API connections / חיבורי API, on the
web app and in the Android app).

## Where requests run

Inside the agent Worker — the Durable Object that already runs every tool — with plain `fetch`.
Nothing goes from the browser or the phone to the API, so there is no CORS, and the web app and
the Android app behave the same (both only talk to the agent API).

## The tool

`http_request { method, url, connection?, query?, headers?, json? | body?, timeout_s? }`

- `method`: GET (default), POST, PUT, PATCH, DELETE.
- `url`: a full `https://` URL, or — with `connection` — a path under the connection's base URL.
  With a connection the request cannot leave its base URL (no `../`, no other host).
- `json` is sent as `application/json`; `body` as text. GET has no body.
- Timeout 15 s by default, 30 s at most.
- Answer: `status`, `ok`, a few useful response headers (content type, rate limits, retry-after…;
  never cookies), and the body — JSON parsed when it is small enough, otherwise text cut to 8,000
  characters. At most 512 KB is read from the network; binary bodies are not shown.
- At most 4 calls per turn.

The system prompt lists the names of the saved connections so the model can pick one.

## Secrets

A connection is a name, an https base URL and the header the key goes in (`Authorization`,
`X-API-Key`, …). The header **value** is the secret. It is stored in the same encrypted store as
the provider keys (`ai.keys` in `tal_settings`, AES-256-GCM, key derived with HKDF from
`SESSION_SECRET`), under `api:<id>`. The API returns only its last four characters.

The model never sees a secret: it names a connection, and the key is added to the request at send
time. The connection's own auth header cannot be set by the model. A key is only sent to the
connection's own origin — not after a redirect to another host. If a server echoes the key back,
it is replaced with `[secret hidden]` before the model sees the answer. Moving a connection's base
URL to another host drops its stored key unless a new one is given.

## Approval and automations

- Anything other than GET goes through the existing Approve/Decline card in the chat. Nothing is
  sent before the owner approves; the result arrives as a notification. This is the setting
  “Ask before changing requests” (`PUT /api/http/settings {confirmNonGet}`), **on** by default.
- Scheduled automations can only make GET requests, whatever the setting.

## SSRF guard

Every hop (redirects included, at most 3, followed by hand) must go to a public host:

- only `http:`/`https:`; no credentials in the URL;
- no loopback, RFC 1918, CGNAT, link-local (cloud metadata `169.254.169.254`), multicast, reserved
  or documentation IPv4 ranges; no `::1`, `fc00::/7`, `fe80::/10`, multicast, documentation IPv6,
  and IPv4-mapped / compatible / NAT64 / 6to4 forms of private IPv4 addresses (URL parsing turns
  `http://2130706433/` and `http://0x7f.1/` into `127.0.0.1`, which is then refused);
- no internal names (`localhost`, `*.local`, `*.internal`, `metadata.google.internal`, single-label
  hosts…);
- names are resolved over DNS-over-HTTPS (A and AAAA) and every address must be public. This is best
  effort: when the resolver cannot be reached the literal checks still apply (and the Workers runtime
  cannot reach private networks in any case). Each check costs up to two subrequests.

## API

- `GET /api/http/connections` → `{ connections, settings, secrets_available }`
- `POST /api/http/connections {name, baseURL, authHeader?, secret?}` → 201 `{ connection }`
- `PUT /api/http/connections/:id {name?, baseURL?, authHeader?, secret? | secret: null}`
- `DELETE /api/http/connections/:id`
- `PUT /api/http/settings {confirmNonGet}`

## Not included

- Connections are not part of the JSON backup/export (like the provider keys).
- Query-string API keys are not supported on connections (header only). A key the owner types into
  the chat would be visible to the model; the prompt tells the model never to ask for one.
