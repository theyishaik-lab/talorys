import type { Env } from "../env";
import { Database } from "../db/database";
import { TaskRepository } from "../db/repositories/tasks";
import { MemoryRepository } from "../db/repositories/memories";
import { NoteRepository, ProjectRepository } from "../db/repositories/notes";
import { ConversationRepository } from "../db/repositories/conversations";
import { AutomationRepository, NotificationRepository } from "../db/repositories/automations";
import { PendingActionRepository } from "../db/repositories/pending-actions";
import { SuggestionRepository } from "../db/repositories/suggestions";
import { SettingsService } from "./settings";
import { ActivityLog, UsageService } from "./usage";
import { AuthService } from "../auth/auth-service";
import { AutomationService, type Scheduler } from "../agent/scheduling";
import { MemoryHistoryService, type MemoryHistoryHooks } from "../memory";
import { parseFcmCredentials } from "../push/fcm";
import { NativePushService } from "../push/native";
import { excerpt, PushService, pushKeysFromEnv } from "../push/service";
import { ProviderKeyStore } from "../ai/keys";
import { ModelCatalogService } from "../ai/catalog";
import { ModelCooldowns } from "../ai/cooldown";
import { EndpointStore } from "../ai/openai-compatible";
import { QuotaObservations } from "../ai/quota";

/** All data services for the single owner, bound to one Durable Object's storage. */
export interface Services {
  db: Database;
  tasks: TaskRepository;
  memories: MemoryRepository;
  notes: NoteRepository;
  projects: ProjectRepository;
  conversations: ConversationRepository;
  automationsRepo: AutomationRepository;
  notifications: NotificationRepository;
  pendingActions: PendingActionRepository;
  /** Proactive engine suggestions surfaced to the owner. */
  suggestions: SuggestionRepository;
  settings: SettingsService;
  usage: UsageService;
  activity: ActivityLog;
  auth: AuthService;
  automations: AutomationService;
  memoryHistory: MemoryHistoryService;
  push: PushService;
  /** Encrypted API keys for Gemini / OpenRouter. */
  providerKeys: ProviderKeyStore;
  /** The model lists Settings shows (cached per Durable Object). */
  catalog: ModelCatalogService;
  /** Models paused after a quota / overload failure (skipped by the fallback chain until then). */
  cooldowns: ModelCooldowns;
  /** OpenAI-compatible endpoints the owner registered (OVH, Groq, …). */
  endpoints: EndpointStore;
  /** The last rate-limit headers each model's provider sent (Settings → Model shows what is left). */
  quotas: QuotaObservations;
}

/** Runs a background promise; the Durable Object passes `ctx.waitUntil`. Errors never surface to the request. */
export type Deliver = (work: Promise<unknown>) => void;

export function createServices(storage: DurableObjectStorage, env: Env, scheduler: Scheduler, memoryHooks: MemoryHistoryHooks = {}, deliver: Deliver = (w) => void w.catch((e) => console.error("push delivery failed", e))): Services {
  const db = new Database(storage);
  const settings = new SettingsService(db, {
    ...(env.TALORYS_DEFAULT_TIMEZONE ? { timezone: env.TALORYS_DEFAULT_TIMEZONE } : {}),
    ...(env.TALORYS_AGENT_NAME ? { agentName: env.TALORYS_AGENT_NAME } : {}),
  });
  const automationsRepo = new AutomationRepository(db);
  const notifications = new NotificationRepository(db);
  const activity = new ActivityLog(db);
  const memories = new MemoryRepository(db);
  const usage = new UsageService(db);
  const push = new PushService(db, pushKeysFromEnv(env), (work) => deliver(work.catch((e) => console.error("push delivery failed", e))));
  const providerKeys = new ProviderKeyStore(settings, env.SESSION_SECRET);
  const catalog = new ModelCatalogService(env.AI, providerKeys);
  push.native = new NativePushService(db, parseFcmCredentials(env.FCM_SERVICE_ACCOUNT), env.PUBLIC_APP_URL ?? "", (work) => deliver(work.catch((e) => console.error("native push delivery failed", e))));
  // Everything that lands in the bell also reaches the devices that asked for it.
  // The full text also lands in a chat thread (one per automation, one shared inbox for the rest),
  // so a tap on the notification opens that thread with the whole content and room to reply.
  const conversations = new ConversationRepository(db);
  notifications.onCreate = (n, kind) => {
    let url = "/chat?notifications=1";
    try {
      const threadId = notificationThreadId(n.automation_id);
      conversations.ensure(threadId, n.automation_id ? n.title : "Notifications");
      conversations.addMessage({ conversation_id: threadId, role: "assistant", content: notificationMessage(n.title, n.body) });
      url = `/chat/${threadId}`;
    } catch (error) {
      console.error("notification thread write failed", error);
    }
    push.notify({ kind, title: n.title, body: excerpt(n.body), tag: `notification-${n.id}`, url });
  };
  return {
    push,
    providerKeys,
    catalog,
    cooldowns: new ModelCooldowns(settings),
    endpoints: new EndpointStore(settings),
    quotas: new QuotaObservations(settings),
    db,
    tasks: new TaskRepository(db),
    memories,
    notes: new NoteRepository(db),
    projects: new ProjectRepository(db),
    conversations,
    automationsRepo,
    notifications,
    pendingActions: new PendingActionRepository(db),
    suggestions: new SuggestionRepository(db),
    settings,
    usage,
    activity,
    auth: new AuthService(db, settings, {
      passwordHash: env.OWNER_PASSWORD_HASH,
      password: env.OWNER_PASSWORD,
      sessionSecret: env.SESSION_SECRET,
    }),
    automations: new AutomationService(automationsRepo, settings, activity, scheduler),
    memoryHistory: new MemoryHistoryService(db, memories, settings, usage, activity, memoryHooks),
  };
}

/** The fixed id of the chat thread a notification is written to: per automation, or the shared inbox. */
export function notificationThreadId(automationId: string | null): string {
  return automationId ? `updates-${automationId.replace(/[^A-Za-z0-9_-]/g, "")}` : "updates-inbox";
}

/** A notification as a chat message: its title as a heading, then the full body. */
export function notificationMessage(title: string, body: string): string {
  const text = body.trim();
  return text && text !== title.trim() ? `**${title.trim()}**\n\n${text}` : `**${title.trim()}**`;
}
