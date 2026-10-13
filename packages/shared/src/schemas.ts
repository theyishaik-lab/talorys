import type { AiAttempt, AiAttribution, AiFailureReason } from "./attribution";
import { z } from "zod";
import { AUTOMATION_KINDS, BACKUP_FORMAT, DEFAULT_MODEL, LIMIT_CEILINGS, MEMORY_CATEGORIES, PROJECT_STATUSES, TASK_PRIORITIES, TASK_STATUSES } from "./constants";
import { isValidTimeZone, scheduleSpecSchema } from "./recurrence";

// ---------- Primitives ----------

const id = z.string().min(1).max(64);
const isoDate = z.string().datetime({ offset: true });
const shortText = (max: number) => z.string().trim().min(1).max(max);

// ---------- Entities ----------

// The entity vocabularies live in ./constants (zod-free, so the web app can import them without
// pulling the validation schemas into its bundle); the types stay here.

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];
export type AutomationKind = (typeof AUTOMATION_KINDS)[number];

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  due_at: string | null;
  project_id: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export const MEMORY_STATUSES = ["active", "historical", "uncertain"] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

export interface Memory {
  id: string;
  content: string;
  category: MemoryCategory;
  source: "manual" | "agent" | "import";
  /** Lifecycle: current fact, past fact kept as history, or flagged as possibly outdated. */
  status: MemoryStatus;
  /** The newer memory that replaced this one, if any. */
  superseded_by: string | null;
  /** When the fact became / stopped being true, only if explicitly stated (YYYY, YYYY-MM or YYYY-MM-DD). */
  valid_from: string | null;
  valid_until: string | null;
  created_at: string;
  updated_at: string;
}

export const MEMORY_REVIEW_RELATIONSHIPS = ["contradiction", "possible_update"] as const;
export const MEMORY_REVIEW_ACTIONS = ["keep_both", "mark_historical", "replace", "cancel"] as const;
export type MemoryReviewAction = (typeof MEMORY_REVIEW_ACTIONS)[number];

/** A possible conflict between a new memory and an older one, waiting for the owner's decision. */
export interface MemoryReview {
  id: string;
  /** The newer memory. */
  memory: Memory;
  /** The older memory it may conflict with. */
  other: Memory;
  relationship: (typeof MEMORY_REVIEW_RELATIONSHIPS)[number];
  reason: string;
  created_at: string;
}

/** Older and newer versions of a fact, oldest first. */
export interface MemoryHistory {
  memory: Memory;
  previous: Memory[];
  next: Memory[];
}

export interface Note {
  id: string;
  title: string;
  content: string;
  project_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  status: (typeof PROJECT_STATUSES)[number];
  created_at: string;
  updated_at: string;
}

export interface Conversation {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  message_count?: number;
}

export type PendingActionStatus = "pending" | "approved" | "cancelled" | "expired" | "failed";

/** One secret the owner types on a connect card. The value goes to the connector and nowhere else. */
export interface ConnectField {
  key: string;
  label: string;
  placeholder?: string;
  hint?: string;
  /** Rendered as a password input (default true: most fields are keys). */
  secret?: boolean;
  required?: boolean;
}

/**
 * The owner-facing card of a `connect_service` proposal: which app, how it authenticates, what the
 * owner must do after approving (open a consent link, or fill in a key on the card itself).
 */
export interface ConnectCard {
  kind: "connect";
  /** Provider id in the connector catalog, e.g. googletasks. */
  service: string;
  /** Display name, e.g. Google Tasks. */
  name: string;
  method: "oauth" | "api_key";
  /** api_key: the fields the owner fills in on the card. Never echoed into chat or stored by Talorys. */
  fields?: ConnectField[];
  /** oauth, after approval: the provider's consent link the owner opens. */
  authorization_url?: string;
  /** Set once the connector confirmed the connection (the account it is connected as, when known). */
  account?: string;
}

/** A destructive action the agent proposed. It runs only when the owner approves it in the UI. */
export interface PendingAction {
  id: string;
  /** Server-written description of the exact target, e.g. `Delete task “Buy milk”`. */
  summary: string;
  status: PendingActionStatus;
  error: string | null;
  expires_at: string;
  /** Present on proposals that need a richer card than Approve/Decline (today: connecting an app). */
  card?: ConnectCard;
}

/** Device notification categories; each subscribed device keeps its own on/off per kind. */
export const PUSH_KINDS = ["approval", "result", "reminder"] as const;
export type PushKind = (typeof PUSH_KINDS)[number];
export type PushPrefs = Record<PushKind, boolean>;

export interface PushSubscriptionView {
  id: string;
  label: string;
  prefs: PushPrefs;
  created_at: string;
  last_used_at: string | null;
  failures: number;
}

export const pushPrefsSchema = z.object({ approval: z.boolean().optional(), result: z.boolean().optional(), reminder: z.boolean().optional() });

/** What `PushSubscription.toJSON()` gives a browser, plus a device label. */
export const pushSubscribeSchema = z.object({
  endpoint: z.string().url().max(2048).refine((u) => u.startsWith("https://"), "Push endpoints must be https."),
  keys: z.object({ p256dh: z.string().min(80).max(120), auth: z.string().min(16).max(32) }),
  label: z.string().max(80).optional(),
  prefs: pushPrefsSchema.optional(),
});
export type PushSubscribeInput = z.infer<typeof pushSubscribeSchema>;

export interface ToolActivity {
  id: string;
  name: string;
  label: string;
  status: "running" | "success" | "error";
  error?: string;
  /** Set when a destructive tool call is waiting for (or got) the owner's approval. */
  approval?: PendingAction;
}

/** Shape check for tool activity stored with a message. Entries that fail it (e.g. from a hostile backup) are dropped on read. */
/** Shape check for a connect card stored with a message (same reason as toolActivitySchema). No secret ever lives here. */
export const connectCardSchema = z.object({
  kind: z.literal("connect"),
  service: z.string(),
  name: z.string(),
  method: z.enum(["oauth", "api_key"]),
  fields: z
    .array(z.object({ key: z.string(), label: z.string(), placeholder: z.string().optional(), hint: z.string().optional(), secret: z.boolean().optional(), required: z.boolean().optional() }))
    .optional(),
  authorization_url: z.string().optional(),
  account: z.string().optional(),
}) satisfies z.ZodType<ConnectCard>;

export const toolActivitySchema = z.object({
  id: z.string(),
  name: z.string(),
  label: z.string(),
  status: z.enum(["running", "success", "error"]),
  error: z.string().optional(),
  approval: z
    .object({
      id: z.string(),
      summary: z.string(),
      status: z.enum(["pending", "approved", "cancelled", "expired", "failed"]),
      error: z.string().nullable(),
      expires_at: z.string(),
      card: connectCardSchema.optional(),
    })
    .optional(),
}) satisfies z.ZodType<ToolActivity>;

export interface ChatMessage {
  id: string;
  conversation_id: string;
  role: "user" | "assistant";
  content: string;
  tools: ToolActivity[];
  status: "complete" | "error" | "cancelled";
  error: string | null;
  /** The API error code behind `error`, so the UI can localize it and offer the right action. */
  error_code?: ApiErrorCode | null;
  created_at: string;
  /** "import" for messages restored from a backup; they never count as live owner input. */
  source?: "chat" | "import";
  /**
   * Assistant messages: the model that wrote the reply (or whose failure ended it), whether a
   * backup answered, and every model that failed on the way. Absent on older messages.
   */
  ai?: AiAttribution | null;
}

export type AutomationStatus = "scheduled" | "running" | "paused" | "completed" | "failed";

export interface Automation {
  id: string;
  name: string;
  kind: AutomationKind;
  message: string;
  schedule: z.infer<typeof scheduleSpecSchema>;
  schedule_description: string;
  enabled: boolean;
  status: AutomationStatus;
  schedule_id: string | null;
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  last_error: string | null;
  run_count: number;
  created_at: string;
  updated_at: string;
}

export interface AutomationRun {
  id: string;
  automation_id: string;
  automation_name: string;
  started_at: string;
  finished_at: string | null;
  status: "running" | "success" | "error" | "skipped";
  result: string | null;
  error: string | null;
}

export interface Notification {
  id: string;
  title: string;
  body: string;
  automation_id: string | null;
  read_at: string | null;
  created_at: string;
}

export interface SessionInfo {
  id: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  user_agent: string;
  current: boolean;
}

// ---------- Input schemas ----------

export const taskCreateSchema = z.object({
  title: shortText(300),
  description: z.string().max(10_000).optional().default(""),
  status: z.enum(TASK_STATUSES).optional().default("todo"),
  priority: z.enum(TASK_PRIORITIES).optional().default("medium"),
  due_at: isoDate.nullable().optional(),
  project_id: id.nullable().optional(),
});
export const taskUpdateSchema = z
  .object({
    title: shortText(300),
    description: z.string().max(10_000),
    status: z.enum(TASK_STATUSES),
    priority: z.enum(TASK_PRIORITIES),
    due_at: isoDate.nullable(),
    project_id: id.nullable(),
  })
  .partial();
export const taskListQuerySchema = z.object({
  status: z.enum([...TASK_STATUSES, "open", "all"]).optional().default("all"),
  view: z.enum(["today", "upcoming", "overdue", "completed", "all"]).optional().default("all"),
  project_id: id.optional(),
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional().default(200),
});

export const memoryCreateSchema = z.object({
  content: shortText(2000),
  category: z.enum(MEMORY_CATEGORIES).optional().default("other"),
});
// Update schemas are declared without defaults: `.partial()` on a schema with
// `.default()` would fill omitted fields and silently overwrite stored values.
export const memoryUpdateSchema = z.object({ content: shortText(2000), category: z.enum(MEMORY_CATEGORIES) }).partial();
export const memoryListQuerySchema = z.object({
  q: z.string().max(200).optional(),
  category: z.enum(MEMORY_CATEGORIES).optional(),
  status: z.enum(["all", "active", "historical", "review"]).optional(),
});
export const memoryStatusSchema = z.object({ status: z.enum(MEMORY_STATUSES) });
/** Records a newer version of a fact; the old memory is kept as history. */
export const memoryCorrectSchema = z.object({ content: shortText(2000), category: z.enum(MEMORY_CATEGORIES).optional() });
export const memoryReviewResolveSchema = z.object({ action: z.enum(MEMORY_REVIEW_ACTIONS) });


export const noteCreateSchema = z.object({
  title: shortText(300),
  content: z.string().max(200_000).optional().default(""),
  project_id: id.nullable().optional(),
});
export const noteUpdateSchema = z
  .object({ title: shortText(300), content: z.string().max(200_000), project_id: id.nullable() })
  .partial();

export const projectCreateSchema = z.object({
  name: shortText(200),
  description: z.string().max(5000).optional().default(""),
  status: z.enum(PROJECT_STATUSES).optional().default("active"),
});
export const projectUpdateSchema = z
  .object({ name: shortText(200), description: z.string().max(5000), status: z.enum(PROJECT_STATUSES) })
  .partial();

export const conversationCreateSchema = z.object({ title: z.string().trim().max(200).optional() });
export const conversationUpdateSchema = z.object({ title: shortText(200) });

export const chatRequestSchema = z.object({
  conversation_id: id.optional(),
  message: shortText(16_000),
  retry: z.boolean().optional(),
});

export const automationCreateSchema = z.object({
  name: shortText(200),
  kind: z.enum(AUTOMATION_KINDS),
  message: z.string().trim().max(4000).optional().default(""),
  schedule: scheduleSpecSchema,
  enabled: z.boolean().optional().default(true),
});
export const automationUpdateSchema = z
  .object({
    name: shortText(200),
    message: z.string().trim().max(4000),
    schedule: scheduleSpecSchema,
    enabled: z.boolean(),
  })
  .partial();

export const limitsSchema = z.object({
  maxOutputTokens: z.number().int().min(64).max(LIMIT_CEILINGS.maxOutputTokens),
  maxToolCalls: z.number().int().min(0).max(LIMIT_CEILINGS.maxToolCalls),
  maxAgentIterations: z.number().int().min(1).max(LIMIT_CEILINGS.maxAgentIterations),
  maxContextTokens: z.number().int().min(1000).max(LIMIT_CEILINGS.maxContextTokens),
  maxScheduledAiRunsPerDay: z.number().int().min(0).max(LIMIT_CEILINGS.maxScheduledAiRunsPerDay),
  maxAiRequestsPerDay: z.number().int().min(1).max(LIMIT_CEILINGS.maxAiRequestsPerDay),
});
export type Limits = z.infer<typeof limitsSchema>;

export const memoryHistorySettingsSchema = z.object({
  /** Detect when a new memory replaces or may contradict an older one (rule-based, no AI). */
  conflictReview: z.boolean(),
  /** Ask the chat model to double-check ambiguous conflicts (uses one AI request per check). */
  aiConflictCheck: z.boolean(),
});
export type MemoryHistorySettings = z.infer<typeof memoryHistorySettingsSchema>;

// ---------- AI providers & models ----------

/** Where the chat model runs. Workers AI is built in; the others need an API key stored on the agent. */
export const AI_PROVIDERS = ["workers-ai", "gemini", "openrouter"] as const;
export type AiProviderId = (typeof AI_PROVIDERS)[number];
export const aiProviderSchema = z.enum(AI_PROVIDERS);

const WORKERS_AI_MODEL = /^@(cf|hf)\/[\w.\-/]+$/;
const OPEN_MODEL_ID = /^[\w.\-/:]+$/;
/** A model id for a given provider: Workers AI ids start with @cf/ or @hf/; the others are plain ids. */
export function isModelIdFor(provider: AiProviderId, model: string): boolean {
  if (model.length === 0 || model.length > 200) return false;
  return provider === "workers-ai" ? WORKERS_AI_MODEL.test(model) : OPEN_MODEL_ID.test(model);
}

/** Any provider's model id: no spaces, no URL (a model is chosen by id, never fetched from an address). */
const modelIdString = z
  .string()
  .min(1)
  .max(200)
  .regex(/^@?[\w.\-/:]+$/, "Not a model id")
  .refine((v) => !v.includes("://"), "Not a model id");

const modelRef = z.object({ provider: aiProviderSchema, model: z.string().min(1).max(200) }).refine((v) => isModelIdFor(v.provider, v.model), "Not a model id of that provider");
/** At most this many extra backups after the selected one (each costs up to a watchdog of silence). */
export const MAX_FALLBACK_CHAIN = 4;
/** One extra backup model in the fallback chain. */
export const fallbackChainEntrySchema = z.object({ provider: aiProviderSchema, model: modelIdString }).refine((v) => isModelIdFor(v.provider, v.model), "Not a model id of that provider");
export type FallbackChainEntry = z.infer<typeof fallbackChainEntrySchema>;
/**
 * Where to turn when the chosen model fails before answering (quota, 503, silence past the
 * watchdog). `provider`/`model` is the selected backup (the field the Settings picker has always
 * written); `chain` is an ordered list of further backups tried after it, so one overloaded
 * provider cannot take the whole chat down. `enabled: false` turns the whole chain off.
 * Settings stored before `chain` existed read as an empty chain.
 */
export const fallbackSchema = z.object({
  enabled: z.boolean(),
  provider: aiProviderSchema,
  model: modelIdString,
  chain: z.array(fallbackChainEntrySchema).max(MAX_FALLBACK_CHAIN).default([]),
});
export type FallbackSettings = z.infer<typeof fallbackSchema>;
export const DEFAULT_FALLBACK: FallbackSettings = { enabled: false, provider: "workers-ai", model: DEFAULT_MODEL, chain: [] };
/**
 * A partial fallback update. Each field is replaced when present and kept when absent — so a
 * client that only knows `enabled`/`provider`/`model` never clears `chain`; `chain: []` clears it.
 */
export const fallbackUpdateSchema = z.object({
  enabled: z.boolean().optional(),
  provider: aiProviderSchema.optional(),
  model: modelIdString.optional(),
  chain: z.array(fallbackChainEntrySchema).max(MAX_FALLBACK_CHAIN).optional(),
});

export const settingsSchema = z
  .object({
    agentName: shortText(60),
    timezone: z.string().refine(isValidTimeZone, "Unknown IANA timezone"),
    theme: z.enum(["system", "light", "dark"]),
    /** The chat model's provider. Settings stored before this field existed are Workers AI. */
    modelProvider: aiProviderSchema.default("workers-ai"),
    model: modelIdString,
    fallback: fallbackSchema.default(DEFAULT_FALLBACK),
    temperature: z.number().min(0).max(1.5),
    limits: limitsSchema,
    autoMemory: z.boolean(),
    /** Documented demo mode: uses the deterministic mock provider instead of Workers AI. */
    demoMode: z.boolean(),
    memoryHistory: memoryHistorySettingsSchema,
  })
  .refine((v) => isModelIdFor(v.modelProvider, v.model), { path: ["model"], message: "Not a model id of the chosen provider" })
  .refine((v) => !v.fallback.enabled || modelRef.safeParse({ provider: v.fallback.provider, model: v.fallback.model }).success, {
    path: ["fallback"],
    message: "Not a model id of the fallback provider",
  });
export type Settings = z.infer<typeof settingsSchema>;
export const settingsUpdateSchema = z.object({
  agentName: shortText(60).optional(),
  timezone: z.string().refine(isValidTimeZone, "Unknown IANA timezone").optional(),
  theme: z.enum(["system", "light", "dark"]).optional(),
  modelProvider: aiProviderSchema.optional(),
  model: modelIdString.optional(),
  fallback: fallbackUpdateSchema.optional(),
  temperature: z.number().min(0).max(1.5).optional(),
  autoMemory: z.boolean().optional(),
  demoMode: z.boolean().optional(),
  limits: limitsSchema.partial().optional(),
  memoryHistory: memoryHistorySettingsSchema.partial().optional(),
});

/** A model as the Settings picker shows it. `tools` = function calling; `free` = no charge beyond the provider's free allowance. */
export interface CatalogModel {
  id: string;
  name: string;
  /** Short English description (the UI localizes the tags, not this line). */
  description: string;
  context: number | null;
  tools: boolean;
  free: boolean;
  /** Rough tiers for the row's tags; null when unknown. */
  speed: "fast" | "balanced" | "slow" | null;
  quality: "basic" | "good" | "best" | null;
  /** USD per million tokens, when the provider publishes it. */
  price: { input: number; output: number } | null;
  /** Talorys has used this model with tool calling. */
  recommended?: boolean;
}

export interface CatalogProvider {
  id: AiProviderId;
  name: string;
  /** Whether the provider can be used now (Workers AI: binding present; others: key stored). */
  connected: boolean;
  /** Masked tail of the stored key, e.g. "…k2Q9". */
  keyHint: string | null;
  keyAddedAt: string | null;
  needsKey: boolean;
  /** Where to get a key. */
  keyUrl: string | null;
  models: CatalogModel[];
  /** Why the live list could not be fetched (a static list is shown instead). */
  error: string | null;
  source: "live" | "static";
}

export interface ModelCatalog {
  providers: CatalogProvider[];
  current: { provider: AiProviderId; model: string };
  fetched_at: string;
}

export const providerKeySchema = z.object({ key: z.string().min(8).max(512) });

export const loginSchema = z.object({ password: z.string().min(1).max(256) });
export const changePasswordSchema = z.object({
  current_password: z.string().min(1).max(256),
  new_password: z.string().min(1).max(256),
});

// ---------- Backup ----------

const backupEntity = <T extends z.ZodRawShape>(shape: T) => z.object(shape).passthrough();

export const backupSchema = z.object({
  format: z.literal(BACKUP_FORMAT),
  version: z.number().int().min(1),
  exported_at: z.string(),
  app_version: z.string().optional(),
  data: z.object({
    settings: z.record(z.string(), z.unknown()).optional().default({}),
    conversations: z.array(backupEntity({ id, title: z.string(), created_at: z.string(), updated_at: z.string() })).default([]),
    messages: z
      .array(
        backupEntity({
          id,
          conversation_id: id,
          role: z.enum(["user", "assistant"]),
          content: z.string(),
          created_at: z.string(),
        }),
      )
      .default([]),
    memories: z.array(backupEntity({ id, content: z.string(), category: z.string(), created_at: z.string(), updated_at: z.string() })).default([]),
    tasks: z.array(backupEntity({ id, title: z.string(), status: z.string(), created_at: z.string(), updated_at: z.string() })).default([]),
    notes: z.array(backupEntity({ id, title: z.string(), content: z.string(), created_at: z.string(), updated_at: z.string() })).default([]),
    projects: z.array(backupEntity({ id, name: z.string(), created_at: z.string(), updated_at: z.string() })).default([]),
    automations: z.array(backupEntity({ id, name: z.string(), kind: z.string(), schedule: z.unknown() })).default([]),
  }),
});
export type Backup = z.infer<typeof backupSchema>;

// ---------- API contract ----------

export type ApiErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VALIDATION_ERROR"
  | "RATE_LIMITED"
  | "AI_QUOTA_EXHAUSTED"
  | "AI_UNAVAILABLE"
  | "AI_LIMIT_REACHED"
  | "CONFLICT"
  | "NOT_CONFIGURED"
  | "INTERNAL_ERROR";

export interface ApiErrorBody {
  error: { code: ApiErrorCode; message: string; details?: unknown };
}

/** Server-sent events emitted by POST /api/chat. */
export type ChatStreamEvent =
  | { type: "start"; conversation_id: string; user_message_id: string; assistant_message_id: string }
  | { type: "text"; delta: string }
  | { type: "tool"; tool: ToolActivity }
  | { type: "title"; conversation_id: string; title: string }
  | {
      type: "error";
      code: ApiErrorCode;
      message: string;
      details?: unknown;
      /** The model whose failure ended the turn (the last one tried). Optional: older agents omit it. */
      provider?: string;
      model?: string;
      /** The provider's HTTP status for that failure, when it sent one. */
      status?: number | null;
      reason?: AiFailureReason;
      /** Every model tried in this turn, in order, each with why it failed. */
      attempts?: AiAttempt[];
    }
  /** A backup started answering instead of the chosen model (sent before its first text). */
  | { type: "model"; provider: string; model: string; fallback: true; attempts: AiAttempt[] }
  | { type: "done"; message: ChatMessage };

export interface HealthReport {
  ok: boolean;
  version: string;
  storage: "ok" | "error";
  schema_version: number;
  configured: { password: boolean; session_secret: boolean };
  ai_binding: boolean;
  time: string;
}

export interface UsageReport {
  day: string;
  today: UsageCounters;
  last_7_days: UsageCounters;
  limits: Limits;
  model: string;
  provider?: AiProviderId;
  note: string;
  dashboard_url: string;
}

export interface UsageCounters {
  ai_requests: number;
  input_tokens_estimate: number;
  output_tokens_estimate: number;
  tool_calls: number;
  scheduled_ai_runs: number;
  ai_errors: number;
}
