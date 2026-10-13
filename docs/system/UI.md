# Changing the UI

The web user interface (browser and installed PWA) is one React app in **`apps/web`**; a web deploy
updates both. The native Android app is a separate React Native app in `apps/mobile` (MOBILE.md) — a
web deploy does not change it.

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
    lib/strings-chain.ts     chain editor strings; lib/strings-pages.ts page strings — both merged into i18n.tsx
    lib/theme.ts             light / dark / auto per device (localStorage "talorys.theme")
    lib/utils.ts             cn() class joining, date/time formatting, copyText
    lib/links.ts             REPO_URL / ANDROID_SOURCE_URL (apps/mobile) / DEPLOY_DOC_URL (this fork), UPSTREAM_URL
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
      ModelPicker.tsx        Settings → AI → Model: providers, models, API keys
      ChainEditor.tsx        Settings → AI → "Model chain": order, status, quota left, add/remove (MODELS.md)
      Markdown.tsx           how assistant messages render
      WriterEditor.tsx       notes editor
      SemanticRecallCard.tsx settings card for semantic memory
      SourceLinks.tsx        GitHubIcon + the "Source · Android" source links (sidebar footer,
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

## Native feel and performance (Oct 13, 2026)

The installed app has to feel like a native one on a mid-range Android phone. What is built, and the
rules that keep it smooth — measured with the harness described at the end of this section.

- **Screen transitions.** The app runs on a data router (`createBrowserRouter`, `main.tsx`) so
  navigations can be View Transitions. `useNav()` in `lib/native.ts` is the one way to navigate with a
  direction: `push` slides the new screen in from the end edge (from the left in Hebrew), `pop` slides it
  back out, `fade` cross-fades (drawer jumps), `none` for same-screen pops. The CSS lives under
  "Screen transitions" in `styles/index.css`; browsers without the API just switch. Settings sub-screens
  (`?tab=`) and notes are pushed (`state: { settingsPushed / notePushed }`), their back buttons pop.
- **Android back button.** `useHistoryLayer(open, onClose)` gives an overlay its own history entry: the
  drawer, every `Dialog` (sheets, confirm dialogs, the notification center). Back closes the overlay
  instead of leaving the app; closing from the UI pops the entry itself. A navigation out of the drawer
  replaces the drawer's entry, so Back from the new screen lands where the drawer was opened.
- **Drawer.** One `Drawer` mounted once on phones (`AppShell`), moved only with `transform`; opening
  toggles nothing inherited on its subtree (that restyled 200 elements per open) — see the comment above
  `.drawer-root` in the stylesheet. `hooks/drawer-gesture.ts`: a swipe in from the start edge opens it,
  a swipe on the panel or scrim closes it, release decides by velocity then position; while the finger
  is down the transform/opacity are written directly, then the CSS transition finishes the move. Note:
  on phones with gesture navigation Android itself owns the first ~20 px of each edge (system Back), so
  the open swipe mostly works with 3-button navigation; tap-to-open and swipe-to-close always work.
- **Streamed replies.** `ChatPage` batches `text` deltas (~80 ms) so a reply updates the screen about
  12 times a second instead of once per token; persisted messages (`MessageView`) and the drawer are
  memoised. The markdown renderer is already memoised per message.
- **Composer.** `field-sizing: content` (Chrome 123+) sizes the textarea without a layout pass per
  keystroke; the JS measurement is only the fallback.
- **Theme switch** adds `.theme-switching` for one frame so the whole screen repaints once instead of
  animating every button's colours for 150 ms.
- **Native-feel CSS** (body): no text selection and no long-press callout on the app's chrome
  (messages, notes and fields opt back in with `.selectable` / `.prose-talorys`), no tap highlight, no
  overscroll / pull-to-refresh, `.pressable` press feedback at 60 ms. `haptic()` (navigator.vibrate)
  ticks on send and on approve/decline.
- **Startup.** `@talorys/shared` is side-effect free and the web app imports values from its zod-free
  subpaths (`/constants`, `/recurrence`, `/password-policy`) — the validation schemas never ship to the
  phone. The other screens' code is prefetched 4 s after login on an idle callback. `manifest`
  `launch_handler: navigate-existing` reuses the open window. A new deploy is picked up quietly: the new
  service worker takes over, and the app reloads the next time it goes to the background (`lib/pwa.ts`).
- **Budget.** `npm run build -w @talorys/web` ends with `scripts/bundle-budget.mjs`: initial JS ≤ 200 KB
  gzip (now ~181), CSS ≤ 20 KB, lazy chunks ≤ 32 KB. A build over budget fails on purpose.

Rules of thumb: animate only `transform`/`opacity`; never toggle `display`/`visibility`/inherited
properties on a big subtree to show or hide it; keep per-token work out of the chat (batch); measure
before and after with the harness.

**Measuring.** The perf harness used for the Oct 13 numbers (Playwright Chromium, 390×844, 4× CPU
throttle, slow-4G, Hebrew UI) lives in the owner's task files (`perf/measure.mjs` — cold load, open
chat, scroll, drawer, typing, settings, theme; `perf/stream-measure.mjs` + `perf/mock-server.mjs` — a
streamed reply without spending model calls; `perf/trace.mjs` — a timeline breakdown). The
before/after table is in the owner's `talorys-perf-report.md`.

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
  cannot be embedded in an iframe.
- **Polling:** notifications refresh every 30 s, chat polls every 1.5 s only while a reply is
  streaming; a device push received while the app is open refreshes both at once (PWA + Web Push,
  `docs/system/NOTIFICATIONS.md`).
- **Mobile:** the same layout serves phone browsers and the installed PWA; test at phone width (about
  390 px) and with the on-screen keyboard.
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
