# Changing the UI

The whole user interface — web and Android — is one React app in **`apps/web`**. The Android app is a
WebView that loads the live site, so a web deploy updates the phone too; no APK rebuild is needed.

## Stack

| Layer | Library |
| --- | --- |
| Framework | React 19 + TypeScript, built with Vite 8 |
| Styling | Tailwind CSS 4 (via `@tailwindcss/vite`), design tokens as CSS variables |
| Routing | React Router 8 |
| Server state | TanStack Query 5 |
| Icons | lucide-react |
| Markdown in chat | react-markdown + remark-gfm |
| Validation / shared types | zod + `@talorys/shared` (`packages/shared/src/schemas.ts`) |

## Where things are

```
apps/web/
  index.html                 page shell (title, theme-color, viewport)
  public/_headers            security headers incl. Content-Security-Policy (see below)
  public/favicon.svg
  functions/api/[[path]].ts  the /api proxy to the agent Worker (do not put UI code here)
  src/
    main.tsx                 bootstraps React, QueryClient, theme, session
    App.tsx                  routes: /chat, /memory, /tasks, /notes, /automations, /settings
    styles/index.css         Tailwind import + ALL design tokens (colors, fonts, animations, dark mode)
    lib/api.ts               fetch wrapper (CSRF header, 401 handling) + streamChat (SSE)
    lib/theme.ts             light / dark / system theme switching (.dark class on <html>)
    lib/utils.ts             cn() class joining, date/time formatting, copyText
    hooks/queries.ts         every API query/mutation + query keys + polling intervals
    hooks/session.tsx        login state
    hooks/toast.tsx          toasts
    components/
      AppShell.tsx           layout: sidebar / bottom nav, header, the bell
      NotificationCenter.tsx the bell list (approval results land here)
      ChatUsage.tsx          "AI usage today" popover (on main, not yet live)
      Markdown.tsx           how assistant messages render
      WriterEditor.tsx       notes editor
      SemanticRecallCard.tsx settings card for semantic memory
      Logo.tsx
      ui/index.tsx           the primitives: Button, Input, Textarea, Select, Label, Badge, Spinner,
                             EmptyState, PageHeader, ErrorNotice, Dialog, ConfirmDialog, Switch, Card
    pages/
      ChatPage.tsx           chat: ChatHeader, EmptyChat (suggestions), ConversationList, MessageView,
                             UserBubble, AssistantBubble, ToolChip, ApprovalCard, Composer
      MemoryPage.tsx  TasksPage.tsx  NotesPage.tsx  AutomationsPage.tsx
      SettingsPage.tsx       tabs General / AI / Privacy / Security / About
      LoginPage.tsx
```

Rules of thumb:

- **Colors, fonts, radii, dark mode:** change the tokens in `src/styles/index.css` (`--color-brand-*`
  is the teal brand scale, hue 185; `:root` and `.dark` hold the light/dark values). Components use
  semantic classes such as `bg-surface`, `text-fg-muted`, `border-border`, `bg-accent` — change the
  token, not every component.
- **Shared building blocks:** `components/ui/index.tsx`. A new button style = a new variant there.
- **Navigation items:** the `NAV` list at the top of `components/AppShell.tsx`.
- **Chat look:** `pages/ChatPage.tsx`. The text on the tool chips ("Running github.list_my_repositories")
  comes from each tool's `label` in the agent (`apps/agent/src/tools/*.ts`,
  `apps/agent/src/openconnector/tools.ts`).
- **The approval card** for outside actions: `ApprovalCard` in `ChatPage.tsx` (calls
  `POST /api/actions/:id/approve|cancel`).
- **New data from the backend:** add the route in `apps/agent/src/api/routes/*`, the schema in
  `packages/shared`, the hook in `hooks/queries.ts`.

## Things to know before designing

- **Hebrew / right-to-left:** the UI has no RTL handling today (`<html lang="en">`, no `dir`
  attributes). Hebrew messages display, but alignment and punctuation follow left-to-right. A good
  first change: `dir="auto"` on message bubbles, the composer and note editor, and logical Tailwind
  classes (`ms-`/`me-`/`ps-`/`pe-`, `text-start`) instead of `ml-`/`mr-`/`text-left`.
- **Content-Security-Policy** (`public/_headers`): only same-origin scripts, styles, fonts, images and
  connections are allowed (`default-src 'self'`). A Google Font, CDN script or external image will be
  blocked unless you bundle it or extend the policy deliberately. `frame-ancestors 'none'` — the app
  cannot be embedded in an iframe (the Android WebView is not affected).
- **Polling:** notifications refresh every 30 s, chat polls every 1.5 s only while a reply is
  streaming; there are no push notifications.
- **Mobile:** the same layout serves the Android WebView; test at phone width (about 390 px) and with
  the on-screen keyboard (the Android app uses `adjustResize`).
- Keep the bundle lean: the app is served from Pages (no size limit worth worrying about), but the
  phone loads it over mobile data.

## Run it locally

```bash
npm install
npm run dev            # http://localhost:5173  (Vite with hot reload)
```

`npm run dev` also starts the agent locally with the **mock AI** (no Cloudflare login needed) and
proxies `/api` through the real Pages Function, so login, chat, tasks etc. all work offline. Set
`TALORYS_DEV_PASSWORD=...` before the first run to choose the local password (or read it from
`apps/agent/.dev.vars`). Mock AI understands: `remember …`, `add task …`, `add note …`,
`complete task …`, `list tasks`, `remind me in N minutes to …`, `search …`.

For the real model: `npx wrangler login` and run `npm run dev:remote-ai -w @talorys/agent` in place of
the agent process.

## Test

```bash
npm test -w @talorys/web     # unit tests (Pages Function)
npm run typecheck
npm run test:e2e             # Playwright: tests/e2e/app.spec.ts, chat-usage.spec.ts, semantic.spec.ts
npm run screenshots          # regenerates docs/screenshots
```

## Ship it

Follow DEPLOY.md §3 (build → staging folder with `dist` + `functions` + `deploy/web.wrangler.jsonc`
→ `wrangler pages deploy`). The agent Worker does not need a redeploy for a pure UI change. To try a
change without touching production, deploy to a preview branch: add `--branch preview` and open the
preview URL Wrangler prints (`https://preview.talorys-lxl5w9o0-web.pages.dev`). A preview talks to the
same live agent and data — it is a new front end, not a sandbox.
