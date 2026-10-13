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
    lib/links.ts             REPO_URL / ANDROID_REPO_URL / DEPLOY_DOC_URL (this fork), UPSTREAM_URL
    hooks/queries.ts         every API query/mutation + query keys + polling intervals
    hooks/session.tsx        login state
    hooks/toast.tsx          toasts
    components/
      AppShell.tsx           layout: sidebar / bottom nav, header, the bell
      NotificationCenter.tsx the bell list (approval results land here)
      ChatUsage.tsx          "AI usage today" popover
      Markdown.tsx           how assistant messages render
      WriterEditor.tsx       notes editor
      SemanticRecallCard.tsx settings card for semantic memory
      SourceLinks.tsx        GitHubIcon + the "Source · Android" repository links (sidebar footer,
                             login footer; the About tab uses the icon too)
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

- **Hebrew / right-to-left (since Oct 13, 2026, commit `9b41c85`):** the UI has two locales,
  English and Hebrew, in `apps/web/src/lib/i18n.tsx`. The language is a per-device preference in
  `localStorage["talorys.lang"]` (`auto` = follow the browser language; `en`; `he`) — it is not part
  of the agent's settings, so it works before login and never touches the backend. Settings → General
  → Language switches it. `initLocale()` sets `<html lang dir>` before the first paint, and
  `LocaleProvider` / `useT()` give components `t("key")` strings. Rules that keep RTL correct:
  - Use **logical** Tailwind classes: `ps-`/`pe-`/`ms-`/`me-`, `start-`/`end-`, `border-s`/`border-e`,
    `rounded-ss/se/es/ee`, `text-start`/`text-end` — never `pl-`/`right-`/`text-left`. The `rtl:`
    variant handles the rest (e.g. `rtl:-scale-x-100` on arrow icons, the Switch knob).
  - **Per-message direction:** user bubbles, Markdown paragraphs/lists/headings/table cells, tool
    chips and titles carry `dir="auto"`, so a Hebrew answer right-aligns in an English UI and vice
    versa; `pre`/`code` are forced `dir="ltr"`. The composer, search boxes and text fields are
    `dir="auto"`; the note editor's textarea and its highlight mirror share one direction from the
    first strong character of the text (`firstStrongDirection`).
  - Dates and relative times (`lib/utils.ts`) follow `<html lang>`, so they read "לפני 5 דקות" in Hebrew.
  - **Adding a string:** add the key to both dictionaries in `i18n.tsx` (TypeScript fails if Hebrew
    is missing a key) and use `t("…")`. Translated so far: the shell (sidebar, bottom nav, bell,
    source links), login, chat (header, history, composer, approval card, dialogs), settings General
    tab and tab names, notifications and shared dialogs. Still English: Memory, Tasks, Notes,
    Automations page contents and the Settings AI/Privacy/Security/About tabs — all already lay out
    RTL, only their words are untranslated.
  - Tests: `apps/web/test/i18n.test.ts`. Visual check: `localStorage.setItem("talorys.lang","he")`
    + reload, at 390 px and desktop width.
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
