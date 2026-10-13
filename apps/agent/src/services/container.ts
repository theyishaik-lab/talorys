import type { Env } from "../env";
import { Database } from "../db/database";
import { TaskRepository } from "../db/repositories/tasks";
import { MemoryRepository } from "../db/repositories/memories";
import { NoteRepository, ProjectRepository } from "../db/repositories/notes";
import { ConversationRepository } from "../db/repositories/conversations";
import { AutomationRepository, NotificationRepository } from "../db/repositories/automations";
import { PendingActionRepository } from "../db/repositories/pending-actions";
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
  notifications.onCreate = (n, kind) => {
    push.notify({ kind, title: n.title, body: excerpt(n.body), tag: `notification-${n.id}`, url: "/chat?notifications=1" });
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
    conversations: new ConversationRepository(db),
    automationsRepo,
    notifications,
    pendingActions: new PendingActionRepository(db),
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
