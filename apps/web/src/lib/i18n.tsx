import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";

/**
 * UI locale + text direction.
 *
 * The preference lives in localStorage (like the theme's first paint), so it is per device and never
 * touches the agent's settings. "auto" follows the browser language; Hebrew flips the whole shell to RTL.
 */
export type Locale = "en" | "he";
export type LocalePreference = "auto" | Locale;
export type Direction = "ltr" | "rtl";

export const LOCALES: readonly Locale[] = ["en", "he"];
const RTL_LOCALES: ReadonlySet<string> = new Set(["he"]);
const STORAGE_KEY = "talorys.lang";

export const LOCALE_NAMES: Record<Locale, string> = { en: "English", he: "עברית" };

export function directionOf(locale: Locale): Direction {
  return RTL_LOCALES.has(locale) ? "rtl" : "ltr";
}

/** Picks the first supported language from the browser's preference list; English otherwise. */
export function detectLocale(languages: readonly string[]): Locale {
  for (const tag of languages) {
    const base = tag.toLowerCase().split(/[-_]/)[0];
    if (base === "he" || base === "iw") return "he";
    if (base === "en") return "en";
  }
  return "en";
}

export function resolveLocale(pref: LocalePreference, languages: readonly string[]): Locale {
  return pref === "auto" ? detectLocale(languages) : pref;
}

export function readPreference(): LocalePreference {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === "en" || v === "he" ? v : "auto";
  } catch {
    return "auto";
  }
}

function browserLanguages(): readonly string[] {
  if (typeof navigator === "undefined") return [];
  return navigator.languages?.length ? navigator.languages : navigator.language ? [navigator.language] : [];
}

/** Sets <html lang dir> so the whole document (scrollbars, dialogs, text alignment) follows the locale. */
export function applyLocale(locale: Locale): void {
  const root = document.documentElement;
  root.lang = locale;
  root.dir = directionOf(locale);
}

/** Applies the last known locale before first render (no inline scripts under our CSP). */
export function initLocale(): Locale {
  const locale = resolveLocale(readPreference(), browserLanguages());
  applyLocale(locale);
  return locale;
}

/**
 * Direction of a piece of text by its first strong (letter) character, the way `dir="auto"` decides it.
 * Used where an element cannot carry dir="auto" itself.
 */
export function firstStrongDirection(text: string, fallback: Direction = "ltr"): Direction {
  for (const ch of text) {
    if (/[\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/u.test(ch)) return "rtl";
    if (/\p{L}/u.test(ch)) return "ltr";
  }
  return fallback;
}

// --- Strings -------------------------------------------------------------------------------------

const en = {
  // Shell
  "nav.chat": "Chat",
  "nav.memory": "Memory",
  "nav.tasks": "Tasks",
  "nav.notes": "Notes",
  "nav.automations": "Automations",
  "nav.schedules": "Schedules",
  "nav.settings": "Settings",
  "nav.lock": "Lock",
  "nav.notifications": "Notifications",
  "nav.notificationsUnread": "Notifications ({n} unread)",
  "notifications.empty": "No notifications",
  "notifications.emptyHint": "Reminders and finished routines will show up here.",
  "notifications.markAllRead": "Mark all read",
  "notifications.delete": "Delete notification",
  "source.source": "Source",
  "source.android": "Android",
  "common.cancel": "Cancel",
  "common.save": "Save",
  "common.delete": "Delete",
  "common.rename": "Rename",
  "common.retry": "Retry",
  "common.close": "Close",
  "common.dismiss": "Dismiss",
  "common.loading": "Loading",
  "common.copy": "Copy",
  "common.copied": "Copied",
  // Login
  "login.tagline": "Your personal AI agent. Your own cloud.",
  "login.password": "Password",
  "login.placeholder": "Owner password",
  "login.show": "Show password",
  "login.hide": "Hide password",
  "login.unlock": "Unlock",
  "login.tryAgainIn": "Try again in {n}s",
  "login.rateLimited": "Too many attempts. For your security, sign-in is paused.",
  "login.failed": "Could not sign in.",
  "login.forgot": "Forgot your password? Reset it from your computer with",
  // Chat
  "chat.new": "New chat",
  "chat.newConversation": "New conversation",
  "chat.conversations": "Conversations",
  "chat.history": "Conversation history",
  "chat.searchHistory": "Search history",
  "chat.searchConversations": "Search conversations",
  "chat.noMatches": "No matches.",
  "chat.noConversations": "No conversations yet.",
  "chat.optionsFor": "Options for {title}",
  "chat.renameTitle": "Rename conversation",
  "chat.title": "Title",
  "chat.deleteTitle": "Delete conversation?",
  "chat.deleteMessage": "“{title}” and all its messages will be permanently deleted.",
  "chat.deleted": "Conversation deleted",
  "chat.loadFailed": "This conversation could not be loaded.",
  "chat.goodMorning": "Good morning",
  "chat.goodAfternoon": "Good afternoon",
  "chat.goodEvening": "Good evening",
  "chat.prompt": "What would you like to do today?",
  "chat.recent": "Recent conversations",
  "chat.suggestion1": "What should I work on today?",
  "chat.suggestion2": "Add a task to review my project tomorrow",
  "chat.suggestion3": "Remember that I prefer short answers",
  "chat.suggestion4": "Every Friday at 5pm, remind me to plan next week",
  "chat.placeholder": "Ask {name} anything…",
  "chat.message": "Message",
  "chat.send": "Send message",
  "chat.stop": "Stop generating",
  "chat.footer": "Runs on your Cloudflare account. {name} can make mistakes — check important details.",
  "chat.thinking": "Thinking",
  "chat.stopped": "Stopped.",
  "chat.connectionLost": "Connection lost.",
  "chat.copyResponse": "Copy response",
  "chat.actionsTaken": "Actions taken",
  "chat.approvalNeeded": "Approval needed",
  "chat.approvalHint": "Nothing changes unless you approve.",
  "chat.approve": "Approve",
  "chat.decline": "Decline",
  "chat.approved": "Approved and done",
  "chat.declined": "Declined — nothing was changed",
  "chat.expired": "Expired — ask again if you still want this",
  "chat.approvalFailed": "Approved, but it failed",
  // Settings
  "settings.title": "Settings",
  "settings.tab.General": "General",
  "settings.tab.AI": "AI & model",
  "settings.tab.Privacy": "Privacy",
  "settings.tab.Security": "Security",
  "settings.tab.About": "About",
  "settings.general": "General",
  "settings.agentName": "Agent name",
  "settings.agentNameHint": "How your assistant introduces itself.",
  "settings.timezone": "Timezone",
  "settings.timezoneHint": "Used for due dates and schedules. Changing it re-schedules automations.",
  "settings.useDeviceTimezone": "Use this device's timezone ({tz})",
  "settings.theme": "Theme",
  "settings.theme.system": "Auto",
  "settings.theme.light": "Light",
  "settings.theme.dark": "Dark",
  "settings.language": "Language",
  "settings.languageHint": "Saved on this device.",
  "settings.language.auto": "Automatic ({name})",
  // Drawer / home (redesign)
  "drawer.menu": "Menu",
  "drawer.search": "Search chats",
  "drawer.today": "Today",
  "drawer.yesterday": "Yesterday",
  "drawer.thisWeek": "This week",
  "drawer.earlier": "Earlier",
  "drawer.yourAgent": "Your agent",
  "home.openTasks": "{n} open tasks",
  "home.noOpenTasks": "No open tasks",
  "home.automations": "{n} automations on",
  "home.tile1.title": "Summarize my mail",
  "home.tile1.sub": "from this morning",
  "home.tile1.prompt": "Summarize the emails I got this morning",
  "home.tile2.title": "What's on my calendar?",
  "home.tile2.sub": "this week",
  "home.tile2.prompt": "What's on my calendar this week?",
  "home.tile3.title": "Add a task",
  "home.tile3.sub": "Google Tasks",
  "home.tile3.prompt": "I want to add a task to Google Tasks",
  "home.tile4.title": "Recent files",
  "home.tile4.sub": "Google Drive",
  "home.tile4.prompt": "Show my most recent files in Google Drive",
  "chat.awaiting": "Awaiting approval",
  // Settings (grouped)
  "settings.appearance": "Appearance",
  "settings.theme.auto": "Auto",
  "settings.deviceNotifications": "Device notifications",
  "settings.deviceNotificationsHint": "Arrives with the installable app.",
  "settings.connections": "Connections",
  "settings.model": "Model",
  "settings.account": "Account",
  "settings.back": "Back",
  "settings.saved": "Settings saved",
  // Device notifications (Web Push) + install
  "push.install": "Install app",
  "push.installHint": "A home-screen icon, full screen, and notifications even when the app is closed.",
  "push.installButton": "Install",
  "push.installed": "Installed as an app on this device.",
  "push.installIos": "On iPhone: Share → Add to Home Screen, then open it from there to turn notifications on.",
  "push.installBrowserMenu": "Use the browser menu → “Install app” / “Add to Home screen”.",
  "push.enable": "Notifications on this device",
  "push.enableHint": "Approvals, results and reminders arrive on this device even when the app is closed.",
  "push.denied": "Blocked by the browser. Allow notifications for this site in its settings, then try again.",
  "push.unsupported": "This browser can't receive push notifications.",
  "push.iosNotInstalled": "On iPhone, notifications work only from the installed app: Share → Add to Home Screen.",
  "push.notConfigured": "Not set up on this install yet (no push keys on the Worker).",
  "push.kind.approval": "Approvals",
  "push.kind.approvalHint": "When the agent needs your OK for an action.",
  "push.kind.result": "Results",
  "push.kind.resultHint": "When an approved action or a connection finishes.",
  "push.kind.reminder": "Reminders & automations",
  "push.kind.reminderHint": "What the bell shows: reminders, digests, scheduled runs.",
  "push.test": "Send test notification",
  "push.testSent": "Test sent — it should appear in a moment.",
  "push.testFailed": "The push service refused it ({status}). Turn notifications off and on again.",
  "push.devices": "{n} device(s) receive notifications.",
  "push.enabledToast": "Notifications are on for this device.",
  "push.disabledToast": "Notifications are off for this device.",
  // Settings → Model (providers, catalog, keys, fallback)
  "model.title": "Model",
  "model.current": "Current model",
  "model.chooseHint": "The model answers every chat and automation. Switching applies to new messages.",
  "model.refresh": "Refresh lists",
  "model.refreshing": "Refreshing…",
  "model.sourceStatic": "Built-in list (the live list could not be fetched: {error})",
  "model.provider.workers-ai": "Cloudflare Workers AI",
  "model.provider.workers-aiHint": "Runs on your own Cloudflare account. Free: 10,000 Neurons a day (≈ a few hundred answers), resets at 00:00 UTC. All models here count against the same allowance.",
  "model.provider.gemini": "Google Gemini",
  "model.provider.geminiHint": "Google's models through a free AI Studio key. The free tier is generous and separate from Cloudflare's; no card needed.",
  "model.provider.openrouter": "OpenRouter",
  "model.provider.openrouterHint": "Many open models behind one key. Only its free models are listed; they have daily limits.",
  "model.connected": "Connected",
  "model.needsKey": "Needs an API key",
  "model.noBinding": "Workers AI is not bound to this Worker.",
  "model.selected": "Selected",
  "model.select": "Use this model",
  "model.recommended": "Tested with Talorys",
  "model.tag.tools": "Tools",
  "model.tag.noTools": "No tools",
  "model.tag.free": "Free",
  "model.tag.paid": "Paid",
  "model.tag.speed.fast": "Fast",
  "model.tag.speed.balanced": "Balanced",
  "model.tag.speed.slow": "Slower, stronger",
  "model.tag.quality.basic": "Basic",
  "model.tag.quality.good": "Good",
  "model.tag.quality.best": "Best",
  "model.tag.context": "{n}k context",
  "model.tag.price": "{in} / {out} USD per M tokens",
  "model.disabledNoKey": "Add a key below to use these models.",
  "model.key.title": "API key",
  "model.key.add": "Add key",
  "model.key.placeholder": "Paste the key",
  "model.key.get": "Get a free key",
  "model.key.save": "Save & check",
  "model.key.saving": "Checking…",
  "model.key.saved": "Key saved. {provider} accepted it.",
  "model.key.stored": "Key stored ({hint}), added {when}",
  "model.key.neverShown": "Stored encrypted on your agent. It is never shown again.",
  "model.key.test": "Check key",
  "model.key.testOk": "{provider} accepted the key.",
  "model.key.remove": "Remove",
  "model.key.removed": "Key removed.",
  "model.key.unavailable": "Keys can't be stored: the Worker has no SESSION_SECRET.",
  "model.key.howGemini": "aistudio.google.com → Get API key → Create API key (free, no card). Paste it here.",
  "model.key.howOpenrouter": "openrouter.ai → Keys → Create key. Free models need no credit.",
  "model.fallback.title": "Backup model",
  "model.fallback.hint": "When the chosen model's quota runs out, answer with this model instead of showing an error.",
  "model.fallback.enable": "Use a backup model",
  "model.fallback.model": "Backup",
  "model.fallback.none": "No other connected model to fall back to.",
  "model.changed": "Model: {name}",
  "model.listEmpty": "No models with tool calling listed right now.",
  // AI tab, other sections
  "ai.learn": "Learn from conversations",
  "ai.learnHint": "Save clearly lasting preferences without being asked. Off = only explicit “remember …”.",
  "ai.demo": "Demo mode",
  "ai.demoHint": "A simple offline responder instead of a real model. Useful when every quota is spent. Never turned on automatically.",
  "ai.limits": "Generation & execution limits",
  "ai.temperature": "Temperature",
  "ai.temperatureHint": "Lower is more focused and predictable.",
  "ai.limit.maxOutputTokens": "Max output tokens",
  "ai.limit.maxOutputTokensHint": "Upper bound for each reply.",
  "ai.limit.maxContextTokens": "Max context tokens",
  "ai.limit.maxContextTokensHint": "Recent history sent to the model. Older messages are summarized.",
  "ai.limit.maxToolCalls": "Max tool calls per request",
  "ai.limit.maxToolCallsHint": "0 disables tools entirely.",
  "ai.limit.maxAgentIterations": "Max reasoning steps",
  "ai.limit.maxAgentIterationsHint": "Model round-trips per request.",
  "ai.limit.maxAiRequestsPerDay": "Max AI requests per day",
  "ai.limit.maxAiRequestsPerDayHint": "Hard daily cap enforced by Talorys.",
  "ai.limit.maxScheduledAiRunsPerDay": "Max scheduled AI runs per day",
  "ai.limit.maxScheduledAiRunsPerDayHint": "Budget for AI routines. Reminders never use AI.",
  "ai.limit.max": "Max {n}.",
  "ai.reset": "Reset",
  "ai.saveLimits": "Save limits",
  "ai.usage": "Usage",
  "ai.usage.requests": "AI requests today",
  "ai.usage.tokens": "Tokens today (est.)",
  "ai.usage.toolCalls": "Tool calls today",
  "ai.usage.scheduled": "Scheduled AI runs",
  "ai.usage.last7": "Last 7 days",
  "ai.usage.last7Hint": "Local estimates measured by Talorys.",
  "ai.usage.last7Value": "{requests} requests · {errors} errors",
  "ai.usage.estimates": "Estimates, not billing data",
  "ai.usage.note": "These numbers are estimates measured by Talorys itself. Exact Workers AI Neuron usage and the remaining free allowance are only in the Cloudflare dashboard.",
  "ai.usage.dashboard": "Open Workers AI usage in the Cloudflare dashboard",
  "ai.memoryHistory": "Memory history",
  "ai.conflictReview": "Memory conflict review",
  "ai.conflictReviewHint": "When a new memory clearly replaces an old one (“I sold my car…”), keep the old one as a past fact. Unclear cases wait for you on the Memory page. Uses no AI.",
  "ai.aiConflictCheck": "Double-check conflicts with AI",
  "ai.aiConflictCheckHint": "For unclear conflicts only, ask the chat model whether they really conflict. One AI request per check. It never changes memories by itself.",
  // Chat errors by code
  "chat.error.AI_QUOTA_EXHAUSTED": "{provider}'s quota is used up — switch to another model in Settings.",
  "chat.error.NOT_CONFIGURED": "{provider} is not set up ({message}). Open Settings → Model.",
  "chat.error.AI_LIMIT_REACHED": "Talorys reached its own daily AI limit. Raise it in Settings → AI.",
  "chat.error.openModel": "Settings → Model",
  "chat.error.AI_UNAVAILABLE": "The model isn't answering right now.",
  "chat.error.allFailed": "None of the models answered.",
  "chat.error.tried": "Models tried",
  "chat.answeredBy": "Answered by {model}",
  "chat.answeredByTitle": "The chosen model didn't answer: {attempts}",
  // Settings home
  "settings.connectionsNone": "No app connected yet. Ask in the chat: “connect Gmail”.",
  "settings.connectionsUnavailable": "Connector not configured.",
  "settings.connectionsError": "Could not read connections ({error}).",
  "settings.app": "App",
  "settings.version": "Version",
  "settings.installedApp": "Installed as an app",
  "settings.notInstalled": "Browser tab",
  // Device notifications: state, diagnostics
  "push.state.title": "Status",
  "push.state.permission": "Permission",
  "push.state.permission.granted": "allowed",
  "push.state.permission.denied": "blocked",
  "push.state.permission.default": "not asked yet",
  "push.state.permission.unsupported": "unsupported",
  "push.state.registered": "Registered on your agent",
  "push.state.yes": "yes",
  "push.state.no": "no",
  "push.state.lastTest": "Last test",
  "push.state.lastTestNone": "none yet",
  "push.state.lastTestOk": "delivered ({status}) {when}",
  "push.state.lastTestFail": "failed ({status}) {when}",
  "push.state.context": "Running in",
  "push.state.context.standalone": "the installed app",
  "push.state.context.browser": "a browser tab",
  "push.state.context.webview": "the old Android app",
  "push.err.webview": "This is the old Android app, which can't receive notifications. Open the site in Chrome and install it from Settings → Install.",
  "push.err.dismissed": "The permission prompt was closed without an answer. Tap the switch again and choose Allow. If no prompt appears: tap the bell icon in Chrome's address bar, or Chrome menu → Settings → Site settings → Notifications → allow this site.",
  "push.err.deniedAndroid": "Notifications are blocked for this site. Android: Settings → Apps → Chrome (or Talorys) → Notifications → allow; then Chrome menu → Settings → Site settings → Notifications → this site → Allow. Then try again.",
  "push.err.deniedIos": "Notifications are blocked. iPhone: Settings → Notifications → Talorys → Allow.",
  "push.err.subscribe": "Chrome could not register with Google's push service ({error}). Check that Google Play services is enabled and the phone is online, then try again.",
  "push.err.server": "Your agent refused the registration ({error}).",
  "push.err.swMissing": "The app's background worker is not installed yet. Reload the page and try again.",
  "push.retry": "Try again",
  "push.testOk": "Delivered — the push service accepted it ({status}). It should show on this device now.",
  "push.testQuiet": "Sent. The app was in the foreground, so no banner — look at the bell.",
  "push.diagnose": "Show details",
} as const;

export type StringKey = keyof typeof en;

const he: Record<StringKey, string> = {
  "nav.chat": "צ'אט",
  "nav.memory": "זיכרון",
  "nav.tasks": "משימות",
  "nav.notes": "פתקים",
  "nav.automations": "אוטומציות",
  "nav.schedules": "תזמונים",
  "nav.settings": "הגדרות",
  "nav.lock": "נעילה",
  "nav.notifications": "התראות",
  "nav.notificationsUnread": "התראות ({n} שלא נקראו)",
  "notifications.empty": "אין התראות",
  "notifications.emptyHint": "תזכורות ושגרות שהסתיימו יופיעו כאן.",
  "notifications.markAllRead": "סמן הכול כנקרא",
  "notifications.delete": "מחק התראה",
  "source.source": "קוד מקור",
  "source.android": "אנדרואיד",
  "common.cancel": "ביטול",
  "common.save": "שמירה",
  "common.delete": "מחיקה",
  "common.rename": "שינוי שם",
  "common.retry": "נסה שוב",
  "common.close": "סגירה",
  "common.dismiss": "סגור",
  "common.loading": "טוען",
  "common.copy": "העתקה",
  "common.copied": "הועתק",
  "login.tagline": "סוכן ה-AI האישי שלך. בענן שלך.",
  "login.password": "סיסמה",
  "login.placeholder": "סיסמת הבעלים",
  "login.show": "הצג סיסמה",
  "login.hide": "הסתר סיסמה",
  "login.unlock": "כניסה",
  "login.tryAgainIn": "נסה שוב בעוד {n} שנ'",
  "login.rateLimited": "יותר מדי ניסיונות. לביטחונך, הכניסה מושהית.",
  "login.failed": "הכניסה נכשלה.",
  "login.forgot": "שכחת את הסיסמה? אפס אותה מהמחשב עם",
  "chat.new": "צ'אט חדש",
  "chat.newConversation": "שיחה חדשה",
  "chat.conversations": "שיחות",
  "chat.history": "היסטוריית שיחות",
  "chat.searchHistory": "חיפוש בהיסטוריה",
  "chat.searchConversations": "חיפוש שיחות",
  "chat.noMatches": "אין תוצאות.",
  "chat.noConversations": "עדיין אין שיחות.",
  "chat.optionsFor": "אפשרויות עבור {title}",
  "chat.renameTitle": "שינוי שם השיחה",
  "chat.title": "כותרת",
  "chat.deleteTitle": "למחוק את השיחה?",
  "chat.deleteMessage": "“{title}” וכל ההודעות בה יימחקו לצמיתות.",
  "chat.deleted": "השיחה נמחקה",
  "chat.loadFailed": "לא ניתן לטעון את השיחה.",
  "chat.goodMorning": "בוקר טוב",
  "chat.goodAfternoon": "צהריים טובים",
  "chat.goodEvening": "ערב טוב",
  "chat.prompt": "מה תרצה לעשות היום?",
  "chat.recent": "שיחות אחרונות",
  "chat.suggestion1": "על מה כדאי לי לעבוד היום?",
  "chat.suggestion2": "הוסף משימה לסקור את הפרויקט שלי מחר",
  "chat.suggestion3": "תזכור שאני מעדיף תשובות קצרות",
  "chat.suggestion4": "כל יום שישי ב-17:00 תזכיר לי לתכנן את השבוע הבא",
  "chat.placeholder": "שאל את {name} כל דבר…",
  "chat.message": "הודעה",
  "chat.send": "שלח הודעה",
  "chat.stop": "עצור",
  "chat.footer": "רץ על חשבון ה-Cloudflare שלך. {name} עלול לטעות — בדוק פרטים חשובים.",
  "chat.thinking": "חושב",
  "chat.stopped": "נעצר.",
  "chat.connectionLost": "החיבור נותק.",
  "chat.copyResponse": "העתק תשובה",
  "chat.actionsTaken": "פעולות שבוצעו",
  "chat.approvalNeeded": "נדרש אישור",
  "chat.approvalHint": "שום דבר לא משתנה בלי האישור שלך.",
  "chat.approve": "אישור",
  "chat.decline": "דחייה",
  "chat.approved": "אושר ובוצע",
  "chat.declined": "נדחה — שום דבר לא השתנה",
  "chat.expired": "פג תוקף — בקש שוב אם עדיין תרצה",
  "chat.approvalFailed": "אושר, אבל נכשל",
  "settings.title": "הגדרות",
  "settings.tab.General": "כללי",
  "settings.tab.AI": "מודל ו-AI",
  "settings.tab.Privacy": "פרטיות",
  "settings.tab.Security": "אבטחה",
  "settings.tab.About": "אודות",
  "settings.general": "כללי",
  "settings.agentName": "שם הסוכן",
  "settings.agentNameHint": "איך העוזר שלך מציג את עצמו.",
  "settings.timezone": "אזור זמן",
  "settings.timezoneHint": "משמש לתאריכי יעד ותזמונים. שינוי מתזמן מחדש את האוטומציות.",
  "settings.useDeviceTimezone": "השתמש באזור הזמן של המכשיר ({tz})",
  "settings.theme": "ערכת נושא",
  "settings.theme.system": "אוטומטי",
  "settings.theme.light": "בהיר",
  "settings.theme.dark": "כהה",
  "settings.language": "שפה",
  "settings.languageHint": "נשמר במכשיר הזה.",
  "settings.language.auto": "אוטומטי ({name})",
  "drawer.menu": "תפריט",
  "drawer.search": "חיפוש בשיחות",
  "drawer.today": "היום",
  "drawer.yesterday": "אתמול",
  "drawer.thisWeek": "השבוע",
  "drawer.earlier": "מוקדם יותר",
  "drawer.yourAgent": "הסוכן שלך",
  "home.openTasks": "{n} משימות פתוחות",
  "home.noOpenTasks": "אין משימות פתוחות",
  "home.automations": "{n} אוטומציות פעילות",
  "home.tile1.title": "סכם את המיילים",
  "home.tile1.sub": "מהבוקר",
  "home.tile1.prompt": "סכם לי את המיילים שקיבלתי הבוקר",
  "home.tile2.title": "מה ביומן?",
  "home.tile2.sub": "השבוע",
  "home.tile2.prompt": "מה יש לי ביומן השבוע?",
  "home.tile3.title": "תוסיף משימה",
  "home.tile3.sub": "Google Tasks",
  "home.tile3.prompt": "אני רוצה להוסיף משימה ל-Google Tasks",
  "home.tile4.title": "קבצים אחרונים",
  "home.tile4.sub": "Google Drive",
  "home.tile4.prompt": "הצג לי את הקבצים האחרונים ב-Google Drive",
  "chat.awaiting": "ממתין לאישור",
  "settings.appearance": "מראה",
  "settings.theme.auto": "אוטומטי",
  "settings.deviceNotifications": "התראות במכשיר",
  "settings.deviceNotificationsHint": "מגיע עם האפליקציה המותקנת.",
  "settings.connections": "חיבורים",
  "settings.model": "מודל",
  "settings.account": "חשבון",
  "settings.back": "חזרה",
  "settings.saved": "ההגדרות נשמרו",
  "push.install": "התקנת האפליקציה",
  "push.installHint": "אייקון במסך הבית, מסך מלא והתראות גם כשהאפליקציה סגורה.",
  "push.installButton": "התקנה",
  "push.installed": "מותקנת כאפליקציה במכשיר הזה.",
  "push.installIos": "באייפון: שיתוף ← הוספה למסך הבית, ואז לפתוח משם כדי להפעיל התראות.",
  "push.installBrowserMenu": "דרך תפריט הדפדפן ← \"התקנת אפליקציה\" / \"הוספה למסך הבית\".",
  "push.enable": "התראות במכשיר הזה",
  "push.enableHint": "אישורים, תוצאות ותזכורות מגיעים למכשיר גם כשהאפליקציה סגורה.",
  "push.denied": "הדפדפן חסם התראות. אפשר אותן לאתר הזה בהגדרות הדפדפן ונסה שוב.",
  "push.unsupported": "הדפדפן הזה לא תומך בהתראות push.",
  "push.iosNotInstalled": "באייפון התראות עובדות רק מהאפליקציה המותקנת: שיתוף ← הוספה למסך הבית.",
  "push.notConfigured": "עדיין לא הוגדר בהתקנה הזו (אין מפתחות push ב-Worker).",
  "push.kind.approval": "אישורים",
  "push.kind.approvalHint": "כשהסוכן צריך את האישור שלך לפעולה.",
  "push.kind.result": "תוצאות",
  "push.kind.resultHint": "כשפעולה מאושרת או חיבור הסתיימו.",
  "push.kind.reminder": "תזכורות ואוטומציות",
  "push.kind.reminderHint": "מה שהפעמון מציג: תזכורות, סיכומים, ריצות מתוזמנות.",
  "push.test": "שלח התראת בדיקה",
  "push.testSent": "נשלחה — אמורה להופיע בעוד רגע.",
  "push.testFailed": "שירות ההתראות סירב ({status}). כבה והפעל את ההתראות מחדש.",
  "push.devices": "{n} מכשירים מקבלים התראות.",
  "push.enabledToast": "ההתראות פעילות במכשיר הזה.",
  "push.disabledToast": "ההתראות כבויות במכשיר הזה.",
  // Settings → Model
  "model.title": "מודל",
  "model.current": "המודל הנוכחי",
  "model.chooseHint": "המודל עונה על כל שיחה ואוטומציה. ההחלפה חלה על הודעות חדשות.",
  "model.refresh": "רענון הרשימות",
  "model.refreshing": "מרענן…",
  "model.sourceStatic": "רשימה מובנית (הרשימה החיה לא נטענה: {error})",
  "model.provider.workers-ai": "Cloudflare Workers AI",
  "model.provider.workers-aiHint": "רץ בחשבון ה-Cloudflare שלך. חינם: 10,000 נוירונים ביום (כמה מאות תשובות), מתאפס ב-03:00 שעון ישראל. כל המודלים כאן נספרים מאותה מכסה.",
  "model.provider.gemini": "Google Gemini",
  "model.provider.geminiHint": "המודלים של גוגל דרך מפתח חינמי מ-AI Studio. המכסה החינמית נדיבה ונפרדת מזו של Cloudflare; בלי כרטיס אשראי.",
  "model.provider.openrouter": "OpenRouter",
  "model.provider.openrouterHint": "הרבה מודלים פתוחים מאחורי מפתח אחד. מוצגים רק המודלים החינמיים; יש להם מגבלות יומיות.",
  "model.connected": "מחובר",
  "model.needsKey": "דרוש מפתח API",
  "model.noBinding": "Workers AI לא מחובר ל-Worker הזה.",
  "model.selected": "נבחר",
  "model.select": "השתמש במודל הזה",
  "model.recommended": "נבדק עם Talorys",
  "model.tag.tools": "כלים",
  "model.tag.noTools": "בלי כלים",
  "model.tag.free": "חינם",
  "model.tag.paid": "בתשלום",
  "model.tag.speed.fast": "מהיר",
  "model.tag.speed.balanced": "מאוזן",
  "model.tag.speed.slow": "איטי יותר, חזק יותר",
  "model.tag.quality.basic": "בסיסי",
  "model.tag.quality.good": "טוב",
  "model.tag.quality.best": "הכי טוב",
  "model.tag.context": "הקשר {n}k",
  "model.tag.price": "{in} / {out} דולר למיליון טוקנים",
  "model.disabledNoKey": "הוסף מפתח למטה כדי להשתמש במודלים האלה.",
  "model.key.title": "מפתח API",
  "model.key.add": "הוספת מפתח",
  "model.key.placeholder": "הדבק את המפתח",
  "model.key.get": "השגת מפתח חינמי",
  "model.key.save": "שמור ובדוק",
  "model.key.saving": "בודק…",
  "model.key.saved": "המפתח נשמר. {provider} אישר אותו.",
  "model.key.stored": "מפתח שמור ({hint}), נוסף {when}",
  "model.key.neverShown": "שמור מוצפן בסוכן שלך. לא יוצג שוב.",
  "model.key.test": "בדיקת מפתח",
  "model.key.testOk": "{provider} אישר את המפתח.",
  "model.key.remove": "הסרה",
  "model.key.removed": "המפתח הוסר.",
  "model.key.unavailable": "אי אפשר לשמור מפתחות: ל-Worker אין SESSION_SECRET.",
  "model.key.howGemini": "aistudio.google.com ← Get API key ← Create API key (חינם, בלי כרטיס). הדבק כאן.",
  "model.key.howOpenrouter": "openrouter.ai ← Keys ← Create key. המודלים החינמיים לא דורשים קרדיט.",
  "model.fallback.title": "מודל גיבוי",
  "model.fallback.hint": "כשנגמרת המכסה של המודל שנבחר, התשובה תגיע מהמודל הזה במקום שגיאה.",
  "model.fallback.enable": "השתמש במודל גיבוי",
  "model.fallback.model": "גיבוי",
  "model.fallback.none": "אין מודל מחובר נוסף לגיבוי.",
  "model.changed": "מודל: {name}",
  "model.listEmpty": "אין כרגע מודלים עם קריאת כלים ברשימה.",
  // AI tab
  "ai.learn": "למידה משיחות",
  "ai.learnHint": "שמירת העדפות קבועות בלי לבקש. כבוי = רק \"תזכור…\" מפורש.",
  "ai.demo": "מצב הדגמה",
  "ai.demoHint": "משיב פשוט ללא מודל אמיתי. שימושי כשכל המכסות נגמרו. לעולם לא מופעל אוטומטית.",
  "ai.limits": "מגבלות יצירה והרצה",
  "ai.temperature": "טמפרטורה",
  "ai.temperatureHint": "נמוך = ממוקד וצפוי יותר.",
  "ai.limit.maxOutputTokens": "מקסימום טוקנים לתשובה",
  "ai.limit.maxOutputTokensHint": "תקרה לכל תשובה.",
  "ai.limit.maxContextTokens": "מקסימום טוקנים להקשר",
  "ai.limit.maxContextTokensHint": "היסטוריה אחרונה שנשלחת למודל. הודעות ישנות מסוכמות.",
  "ai.limit.maxToolCalls": "מקסימום קריאות כלים לבקשה",
  "ai.limit.maxToolCallsHint": "0 מכבה כלים לגמרי.",
  "ai.limit.maxAgentIterations": "מקסימום צעדי חשיבה",
  "ai.limit.maxAgentIterationsHint": "סבבים מול המודל לכל בקשה.",
  "ai.limit.maxAiRequestsPerDay": "מקסימום בקשות AI ביום",
  "ai.limit.maxAiRequestsPerDayHint": "תקרה יומית קשיחה של Talorys.",
  "ai.limit.maxScheduledAiRunsPerDay": "מקסימום ריצות AI מתוזמנות ביום",
  "ai.limit.maxScheduledAiRunsPerDayHint": "תקציב לשגרות AI. תזכורות לא משתמשות ב-AI.",
  "ai.limit.max": "מקסימום {n}.",
  "ai.reset": "איפוס",
  "ai.saveLimits": "שמירת מגבלות",
  "ai.usage": "שימוש",
  "ai.usage.requests": "בקשות AI היום",
  "ai.usage.tokens": "טוקנים היום (הערכה)",
  "ai.usage.toolCalls": "קריאות כלים היום",
  "ai.usage.scheduled": "ריצות AI מתוזמנות",
  "ai.usage.last7": "7 ימים אחרונים",
  "ai.usage.last7Hint": "הערכות מקומיות שנמדדו על ידי Talorys.",
  "ai.usage.last7Value": "{requests} בקשות · {errors} שגיאות",
  "ai.usage.estimates": "הערכות, לא נתוני חיוב",
  "ai.usage.note": "המספרים האלה הם הערכות של Talorys עצמו. שימוש מדויק בנוירונים של Workers AI והמכסה שנותרה נמצאים רק בלוח הבקרה של Cloudflare.",
  "ai.usage.dashboard": "פתח את השימוש ב-Workers AI בלוח הבקרה של Cloudflare",
  "ai.memoryHistory": "היסטוריית זיכרון",
  "ai.conflictReview": "בדיקת סתירות בזיכרון",
  "ai.conflictReviewHint": "כשזיכרון חדש מחליף בבירור זיכרון ישן (\"מכרתי את האוטו…\"), הישן נשמר כעובדת עבר. מקרים לא ברורים מחכים לך בעמוד הזיכרון. בלי AI.",
  "ai.aiConflictCheck": "אימות סתירות עם AI",
  "ai.aiConflictCheckHint": "רק לסתירות לא ברורות: לשאול את המודל אם הן באמת סותרות. בקשת AI אחת לכל בדיקה. לא משנה זיכרונות בעצמו.",
  // Chat errors
  "chat.error.AI_QUOTA_EXHAUSTED": "נגמרה המכסה של {provider} — עבור למודל אחר בהגדרות.",
  "chat.error.NOT_CONFIGURED": "{provider} לא מוגדר ({message}). פתח הגדרות ← מודל.",
  "chat.error.AI_LIMIT_REACHED": "Talorys הגיע למגבלת ה-AI היומית שלו. אפשר להעלות אותה בהגדרות ← AI.",
  "chat.error.openModel": "הגדרות ← מודל",
  "chat.error.AI_UNAVAILABLE": "המודל לא עונה כרגע.",
  "chat.error.allFailed": "אף מודל לא ענה.",
  "chat.error.tried": "מודלים שנוסו",
  "chat.answeredBy": "ענה: {model}",
  "chat.answeredByTitle": "המודל שנבחר לא ענה: {attempts}",
  // Settings home
  "settings.connectionsNone": "עדיין לא חובר אף שירות. בקש בצ'אט: \"חבר את Gmail\".",
  "settings.connectionsUnavailable": "הקונקטור לא מוגדר.",
  "settings.connectionsError": "לא הצלחתי לקרוא את החיבורים ({error}).",
  "settings.app": "אפליקציה",
  "settings.version": "גרסה",
  "settings.installedApp": "מותקן כאפליקציה",
  "settings.notInstalled": "לשונית דפדפן",
  // Device notifications: state
  "push.state.title": "מצב",
  "push.state.permission": "הרשאה",
  "push.state.permission.granted": "מאושרת",
  "push.state.permission.denied": "חסומה",
  "push.state.permission.default": "עוד לא נשאלה",
  "push.state.permission.unsupported": "לא נתמך",
  "push.state.registered": "רשום בסוכן",
  "push.state.yes": "כן",
  "push.state.no": "לא",
  "push.state.lastTest": "בדיקה אחרונה",
  "push.state.lastTestNone": "עוד לא",
  "push.state.lastTestOk": "נמסרה ({status}) {when}",
  "push.state.lastTestFail": "נכשלה ({status}) {when}",
  "push.state.context": "רץ בתוך",
  "push.state.context.standalone": "האפליקציה המותקנת",
  "push.state.context.browser": "לשונית דפדפן",
  "push.state.context.webview": "האפליקציה הישנה לאנדרואיד",
  "push.err.webview": "זו האפליקציה הישנה לאנדרואיד, שלא יכולה לקבל התראות. פתח את האתר ב-Chrome והתקן אותו מהגדרות ← התקנה.",
  "push.err.dismissed": "חלון ההרשאה נסגר בלי תשובה. לחץ שוב על המתג ובחר \"אפשר\". אם לא מופיע חלון: לחץ על אייקון הפעמון בשורת הכתובת של Chrome, או תפריט Chrome ← הגדרות ← הגדרות אתרים ← התראות ← אפשר לאתר הזה.",
  "push.err.deniedAndroid": "ההתראות חסומות לאתר הזה. באנדרואיד: הגדרות ← אפליקציות ← Chrome (או Talorys) ← התראות ← אפשר; ואז תפריט Chrome ← הגדרות ← הגדרות אתרים ← התראות ← האתר הזה ← אפשר. ואז נסה שוב.",
  "push.err.deniedIos": "ההתראות חסומות. באייפון: הגדרות ← התראות ← Talorys ← אפשר.",
  "push.err.subscribe": "Chrome לא הצליח להירשם לשירות ההתראות של גוגל ({error}). ודא ש-Google Play services פעיל ושיש אינטרנט, ונסה שוב.",
  "push.err.server": "הסוכן שלך דחה את הרישום ({error}).",
  "push.err.swMissing": "עובד הרקע של האפליקציה עדיין לא מותקן. רענן את הדף ונסה שוב.",
  "push.retry": "נסה שוב",
  "push.testOk": "נמסרה — שירות ההתראות קיבל אותה ({status}). היא אמורה להופיע במכשיר עכשיו.",
  "push.testQuiet": "נשלחה. האפליקציה הייתה פתוחה בחזית, אז בלי באנר — תסתכל בפעמון.",
  "push.diagnose": "הצג פרטים",
};

const STRINGS: Record<Locale, Record<StringKey, string>> = { en, he };

export type Vars = Record<string, string | number>;

export function translate(locale: Locale, key: StringKey, vars?: Vars): string {
  let s: string = STRINGS[locale][key] ?? en[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

// --- React ---------------------------------------------------------------------------------------

export interface LocaleContextValue {
  locale: Locale;
  dir: Direction;
  preference: LocalePreference;
  /** The locale "auto" would pick on this device. */
  detected: Locale;
  setPreference: (pref: LocalePreference) => void;
  t: (key: StringKey, vars?: Vars) => string;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<LocalePreference>(readPreference);
  const detected = useMemo(() => detectLocale(browserLanguages()), []);
  const locale = preference === "auto" ? detected : preference;

  useEffect(() => applyLocale(locale), [locale]);

  const setPreference = useCallback((pref: LocalePreference) => {
    try {
      if (pref === "auto") localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, pref);
    } catch {
      /* storage unavailable */
    }
    setPreferenceState(pref);
  }, []);

  const value = useMemo<LocaleContextValue>(
    () => ({
      locale,
      dir: directionOf(locale),
      preference,
      detected,
      setPreference,
      t: (key, vars) => translate(locale, key, vars),
    }),
    [locale, preference, detected, setPreference],
  );
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleContextValue {
  const ctx = useContext(LocaleContext);
  if (!ctx) throw new Error("useLocale must be used inside <LocaleProvider>");
  return ctx;
}

/** Shorthand for the translate function of the current locale. */
export function useT(): (key: StringKey, vars?: Vars) => string {
  return useLocale().t;
}
