/**
 * The apps the agent can name without a catalog lookup (the catalog has ~1,400 providers and its
 * listing is 6 MB, far past what this Worker can read on the free plan). Hebrew names and common
 * aliases let a Hebrew request land on the right id. Ids verified against the live catalog on
 * Oct 13, 2026. Shared by the connect tools and by the "not connected" error path, which needs a
 * display name without the admin side.
 */
export interface KnownService {
  id: string;
  name: string;
  he: string;
  aliases: string[];
}

export const KNOWN_SERVICES: KnownService[] = [
  { id: "gmail", name: "Gmail", he: "ג'ימייל", aliases: ["google mail", "mail", "email", "מייל", "אימייל", "דואר"] },
  { id: "googlecalendar", name: "Google Calendar", he: "יומן גוגל", aliases: ["calendar", "google calendar", "יומן", "לוח שנה"] },
  { id: "googledrive", name: "Google Drive", he: "גוגל דרייב", aliases: ["drive", "google drive", "דרייב"] },
  { id: "googledocs", name: "Google Docs", he: "גוגל דוקס", aliases: ["docs", "google docs", "דוקס", "מסמכים"] },
  { id: "googlesheets", name: "Google Sheets", he: "גוגל שיטס", aliases: ["sheets", "google sheets", "spreadsheet", "שיטס", "גיליונות", "גיליון"] },
  { id: "googletasks", name: "Google Tasks", he: "משימות גוגל", aliases: ["tasks", "google tasks", "טאסקס", "משימות"] },
  { id: "googleforms", name: "Google Forms", he: "גוגל פורמס", aliases: ["forms", "google forms", "טפסים"] },
  { id: "googlephotos", name: "Google Photos", he: "גוגל תמונות", aliases: ["photos", "google photos", "תמונות"] },
  { id: "youtube", name: "YouTube", he: "יוטיוב", aliases: ["youtube", "יוטיוב"] },
  { id: "github", name: "GitHub", he: "גיטהאב", aliases: ["github", "גיטהאב", "גיט"] },
  { id: "notion", name: "Notion", he: "נושן", aliases: ["notion", "נושן", "נוישן"] },
  { id: "slack", name: "Slack", he: "סלאק", aliases: ["slack", "סלאק"] },
  { id: "todoist", name: "Todoist", he: "טודואיסט", aliases: ["todoist", "טודואיסט"] },
  { id: "linear", name: "Linear", he: "לינאר", aliases: ["linear", "לינאר"] },
  { id: "trello", name: "Trello", he: "טרלו", aliases: ["trello", "טרלו"] },
  { id: "asana", name: "Asana", he: "אסאנה", aliases: ["asana", "אסאנה"] },
  { id: "clickup", name: "ClickUp", he: "קליקאפ", aliases: ["clickup", "click up", "קליקאפ"] },
  { id: "monday", name: "Monday", he: "מאנדיי", aliases: ["monday", "monday.com", "מאנדיי"] },
  { id: "jira", name: "Jira", he: "ג'ירה", aliases: ["jira", "ג'ירה", "גירה"] },
  { id: "confluence", name: "Confluence", he: "קונפלואנס", aliases: ["confluence", "קונפלואנס"] },
  { id: "airtable", name: "Airtable", he: "אירטייבל", aliases: ["airtable", "אירטייבל"] },
  { id: "dropbox", name: "Dropbox", he: "דרופבוקס", aliases: ["dropbox", "דרופבוקס"] },
  { id: "outlook", name: "Outlook", he: "אאוטלוק", aliases: ["outlook", "microsoft mail", "אאוטלוק"] },
  { id: "discord", name: "Discord", he: "דיסקורד", aliases: ["discord", "דיסקורד"] },
  { id: "telegram", name: "Telegram Bot", he: "בוט טלגרם", aliases: ["telegram", "טלגרם"] },
  { id: "whatsapp", name: "WhatsApp Business", he: "וואטסאפ עסקי", aliases: ["whatsapp", "וואטסאפ", "ווטסאפ"] },
  { id: "spotify", name: "Spotify", he: "ספוטיפיי", aliases: ["spotify", "ספוטיפיי"] },
  { id: "zoom", name: "Zoom", he: "זום", aliases: ["zoom", "זום"] },
  { id: "calendly", name: "Calendly", he: "קלנדלי", aliases: ["calendly", "קלנדלי"] },
  { id: "hubspot", name: "HubSpot", he: "האבספוט", aliases: ["hubspot", "האבספוט"] },
  { id: "figma", name: "Figma", he: "פיגמה", aliases: ["figma", "פיגמה"] },
  { id: "canva", name: "Canva", he: "קנבה", aliases: ["canva", "קנבה"] },
  { id: "twitter", name: "X (Twitter)", he: "טוויטר", aliases: ["twitter", "x", "טוויטר"] },
  { id: "linkedin", name: "LinkedIn", he: "לינקדאין", aliases: ["linkedin", "לינקדאין"] },
  { id: "reddit", name: "Reddit", he: "רדיט", aliases: ["reddit", "רדיט"] },
  { id: "gitlab", name: "GitLab", he: "גיטלאב", aliases: ["gitlab", "גיטלאב"] },
  { id: "bitbucket", name: "Bitbucket", he: "ביטבאקט", aliases: ["bitbucket", "ביטבאקט"] },
  { id: "vercel", name: "Vercel", he: "ורסל", aliases: ["vercel", "ורסל"] },
  { id: "stripe", name: "Stripe", he: "סטרייפ", aliases: ["stripe", "סטרייפ"] },
  { id: "openai", name: "OpenAI", he: "OpenAI", aliases: ["openai", "chatgpt", "צ'אט ג'יפיטי"] },
  { id: "anthropic", name: "Anthropic", he: "Anthropic", aliases: ["anthropic", "claude", "קלוד"] },
  { id: "strava", name: "Strava", he: "סטרבה", aliases: ["strava", "סטרבה"] },
  { id: "ticktick", name: "TickTick", he: "טיקטיק", aliases: ["ticktick", "tick tick", "טיקטיק"] },
  { id: "readwise", name: "Readwise", he: "רידווייז", aliases: ["readwise"] },
  { id: "mailchimp", name: "Mailchimp", he: "מיילצ'ימפ", aliases: ["mailchimp", "מיילצ'ימפ"] },
  { id: "zendesk", name: "Zendesk", he: "זנדסק", aliases: ["zendesk", "זנדסק"] },
  { id: "intercom", name: "Intercom", he: "אינטרקום", aliases: ["intercom", "אינטרקום"] },
];

const norm = (s: string) => s.toLowerCase().replace(/[\s_\-.]+/g, "");

/**
 * Turns what the owner or the model wrote ("Google Tasks", "משימות גוגל", "google_tasks") into
 * catalog ids to try, best first. A plain catalog-looking id is tried as written too.
 */
export function resolveServiceIds(text: string): string[] {
  const raw = text.trim();
  const q = norm(raw);
  if (!q) return [];
  const ids: string[] = [];
  const add = (id: string) => {
    if (!ids.includes(id)) ids.push(id);
  };
  for (const s of KNOWN_SERVICES) if (s.id === q || norm(s.name) === q || norm(s.he) === q || s.aliases.some((a) => norm(a) === q)) add(s.id);
  for (const s of KNOWN_SERVICES) if (q.includes(s.id) || q.includes(norm(s.name)) || (s.he && q.includes(norm(s.he)))) add(s.id);
  for (const s of KNOWN_SERVICES) if (s.aliases.some((a) => a.length > 3 && q.includes(norm(a)))) add(s.id);
  if (/^[a-z0-9_]{2,60}$/.test(raw.toLowerCase())) add(raw.toLowerCase());
  if (/^[a-z0-9]{2,60}$/.test(q)) add(q);
  return ids.slice(0, 4);
}

/** Known services whose name or aliases contain the query words; the whole list when the query is empty. */
export function searchKnownServices(query: string | undefined, limit = 12): KnownService[] {
  const q = norm(query ?? "");
  if (!q) return KNOWN_SERVICES.slice(0, limit);
  const hits = KNOWN_SERVICES.filter((s) => [s.id, s.name, s.he, ...s.aliases].some((a) => norm(a).includes(q) || q.includes(norm(a))));
  return hits.slice(0, limit);
}

/** The display name for a catalog service id: "googletasks" → "Google Tasks"; unknown ids are returned as written. */
export function serviceDisplayName(service: string): string {
  return KNOWN_SERVICES.find((s) => s.id === service)?.name ?? service;
}

/**
 * The web domain of each known service, for its logo. The catalog the Worker can read has no
 * images, so the logo is the site's own icon through Google's public favicon service (no key).
 */
const SERVICE_DOMAINS: Record<string, string> = {
  gmail: "mail.google.com", googlecalendar: "calendar.google.com", googledrive: "drive.google.com", googledocs: "docs.google.com",
  googlesheets: "sheets.google.com", googletasks: "tasks.google.com", googleforms: "forms.google.com", googlephotos: "photos.google.com",
  youtube: "youtube.com", github: "github.com", notion: "notion.so", slack: "slack.com", todoist: "todoist.com", linear: "linear.app",
  trello: "trello.com", asana: "asana.com", clickup: "clickup.com", monday: "monday.com", jira: "atlassian.com", confluence: "atlassian.com",
  airtable: "airtable.com", dropbox: "dropbox.com", outlook: "outlook.com", discord: "discord.com", telegram: "telegram.org",
  whatsapp: "whatsapp.com", spotify: "spotify.com", zoom: "zoom.us", calendly: "calendly.com", hubspot: "hubspot.com", figma: "figma.com",
  canva: "canva.com", twitter: "x.com", linkedin: "linkedin.com", reddit: "reddit.com", gitlab: "gitlab.com", bitbucket: "bitbucket.org",
  vercel: "vercel.com", stripe: "stripe.com", openai: "openai.com", anthropic: "anthropic.com", strava: "strava.com", ticktick: "ticktick.com",
  readwise: "readwise.io", mailchimp: "mailchimp.com", zendesk: "zendesk.com", intercom: "intercom.com",
};

/** A logo URL for a service id, or null when its domain is unknown. */
export function serviceLogo(service: string): string | null {
  const domain = SERVICE_DOMAINS[service];
  return domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=128` : null;
}
