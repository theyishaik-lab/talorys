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
  "settings.tab.AI": "AI & model",
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
