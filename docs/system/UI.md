# Changing the UI

The whole user interface — web and Android — is one React app in **`apps/web`**. The Android app is a
WebView that loads the live site, so a web deploy updates the phone too; no APK rebuild is needed.

## Stack

| Layer | Library |
| --- | --- |
| Framework | React 19 + TypeScript, built with Vite 8 |
| Styling | Tailwind CSS 4 (via `@tailwindcss/vite`), design tokens as CSS variables |
| Type | Inter Variable (Latin) + Heebo Variable (Hebrew), self-hosted from `@fontsource-variable/*` |
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
    styles/index.css         Tailwind import + fonts + ALL design tokens (colors, radii, shadows,
                             animations, dark mode, native-feel base rules)
    lib/api.ts               fetch wrapper (CSRF header, 401 handling) + streamChat (SSE)
    lib/theme.ts             light / dark / auto per device (localStorage "talorys.theme")
    lib/utils.ts             cn() class joining, date/time formatting, copyText
    lib/links.ts             REPO_URL / ANDROID_REPO_URL / DEPLOY_DOC_URL (this fork), UPSTREAM_URL
    hooks/queries.ts         every API query/mutation + query keys + polling intervals
    hooks/session.tsx        login state
    hooks/toast.tsx          toasts
    components/
      AppShell.tsx           layout: the drawer (phone) / sidebar (≥1024 px), TopBar, MenuButton,
                             BellButton, IconButton, useShell()
      Drawer.tsx             the one navigation surface: search, new chat, pages, chats by day,
                             account row (ConversationList lives here)
      DeviceNotifications.tsx Settings → "Device notifications": install, enable push, per-kind toggles, test (NOTIFICATIONS.md)
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
      ChatPage.tsx           chat: ChatHeader, EmptyChat (home: greeting, today chips, tiles),
                             MessageView, UserBubble, AssistantBubble, ToolChip, ApprovalCard, Composer
      MemoryPage.tsx  TasksPage.tsx  NotesPage.tsx  AutomationsPage.tsx
      SettingsPage.tsx       grouped list (Appearance, Device notifications, Connections, Account)
                             + sub-screens ?tab=General|AI|Privacy|Security|About with a back bar
      LoginPage.tsx
```

Rules of thumb:

- **Colors, fonts, radii, dark mode:** change the tokens in `src/styles/index.css`. `:root` holds the
  light values, `.dark` the dark ones, and the same dark block is repeated under
  `@media (prefers-color-scheme: dark) { :root:not(.light) }` so "auto" is right on the very first
  paint. Components use semantic classes such as `bg-surface`, `text-fg-muted`, `border-border`,
  `bg-accent`, `bg-bubble-user` — change the token, not every component. The accent (`--accent`,
  indigo `#4C47E0` light / `#8F8CFF` dark) is a **placeholder until the brand is chosen**; swap those
  four accent tokens and `--color-brand-*` when the name/logo land.
- **Shared building blocks:** `components/ui/index.tsx`. A new button style = a new variant there.
  Buttons and tappable rows carry the `pressable` class (150 ms press-scale).
- **Navigation items:** the `PAGES` list at the top of `components/Drawer.tsx`.
- **Chat look:** `pages/ChatPage.tsx`. The text on the tool chips ("Running github.list_my_repositories")
  comes from each tool's `label` in the agent (`apps/agent/src/tools/*.ts`,
  `apps/agent/src/openconnector/tools.ts`).
- **The approval card** for outside actions: `ApprovalCard` in `ChatPage.tsx` (calls
  `POST /api/actions/:id/approve|cancel`).
- **New data from the backend:** add the route in `apps/agent/src/api/routes/*`, the schema in
  `packages/shared`, the hook in `hooks/queries.ts`.

## The design (redesign of Oct 13, 2026, commit `b113f87`; mockups in the owner's files)

One calm neutral surface, one accent, content first. Phone first, the same layout mirrored for Hebrew.

- **Tokens:** greys `--bg/--surface/--subtle/--muted`, text `--fg/--fg-2/--fg-muted/--fg-subtle`,
  lines `--border/--border-strong`, the accent trio, `--success/--warning/--danger` (+ `-soft`),
  `--bubble-user`, `--scrim`, `--shadow`. Radii on a 4-pt grid: `rounded-lg` 10, `rounded-xl` 14,
  `rounded-2xl` 20, `rounded-3xl` 28. Icons: lucide, 18–20 px, stroke 1.75–2.
- **Theme:** Settings → Appearance → Light / Dark / Auto (`lib/theme.ts`). Per device, in
  `localStorage["talorys.theme"]`; "auto" removes both classes and lets the stylesheet's
  `prefers-color-scheme` block decide, "light"/"dark" put that class on `<html>`. The
  `<meta name="theme-color">` is kept in sync so an installed app's status bar matches.
- **Shell:** no bottom navigation. One **history drawer** (`Drawer.tsx`) with search, new chat, the
  four pages, the chats grouped Today / Yesterday / This week / Earlier, and the account row with the
  Settings gear. On phones it slides in from the start edge (the right in Hebrew) over a scrim
  (`useShell().openDrawer()`); from 1024 px it is a fixed sidebar. Chat and Settings draw their own
  `TopBar`; other pages get a bar with menu · title · bell from `AppShell`.
- **Chat:** assistant replies are plain text (no avatar, Markdown via `.prose-talorys`), user
  messages are dark bubbles (`bg-bubble-user`), tool calls are small chips above the reply, the
  approval card is verb-first (app icon, summary, "awaiting approval" badge, full-width Approve +
  Decline, hint line). The composer is a pill with a round send button; it sits inside the safe area
  and the viewport is `100dvh` with `interactive-widget=resizes-content`, so the keyboard pushes it up.
- **Home (empty chat):** greeting by time of day, "today" chips from local data (open tasks, active
  automations), four suggestion tiles (`TILES` in `ChatPage.tsx`, strings `home.tile*`).
- **Settings:** a grouped list the way native settings look (`Section` = label + box, `LinkRow` =
  row with chevron that opens `?tab=…`, `Row` = label/hint + control). Appearance holds the theme
  segmented control and the language select. "Device notifications" is `DeviceNotifications.tsx`
  (Phase 2 replaces its body with the real enable button, toggles and the test button).
- **Dialogs** (`ui/Dialog`) are bottom sheets on phones (grab handle, safe-area padding) and centered
  cards from 640 px.
- **Native feel:** `overscroll-behavior: none` on the document, `touch-action: manipulation`, safe-area
  insets on the top bar / composer / drawer / sheets, `pressable` press-scale, 150–260 ms eased
  transitions, and `prefers-reduced-motion` turns animation off.
- **Fonts** are bundled (`@import "@fontsource-variable/inter"` / `heebo` in `index.css`), so the
  CSP's `font-src 'self'` holds; no Google Fonts request leaves the device.

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
    Automations page contents and the Settings AI/Privacy/Security/About sub-screens — all already lay
    out RTL, only their words are untranslated.
  - Tests: `apps/web/test/i18n.test.ts`. Visual check: `localStorage.setItem("talorys.lang","he")`
    + reload, at 390 px and desktop width.
- **Content-Security-Policy** (`public/_headers`): only same-origin scripts, styles, fonts, images and
  connections are allowed (`default-src 'self'`). A Google Font, CDN script or external image will be
  blocked unless you bundle it or extend the policy deliberately. `frame-ancestors 'none'` — the app
  cannot be embedded in an iframe (the Android WebView is not affected).
- **Polling:** notifications refresh every 30 s, chat polls every 1.5 s only while a reply is
  streaming; a device push received while the app is open refreshes both at once (PWA + Web Push,
  `docs/system/NOTIFICATIONS.md`).
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
