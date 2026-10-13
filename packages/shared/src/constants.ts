export const TALORYS_VERSION = "0.1.5";

/** Stable identity of the single owner's agent inside the private DO namespace. */
export const AGENT_INSTANCE_NAME = "personal-agent";

/**
 * Default Workers AI model. Verified on developers.cloudflare.com/workers-ai/models:
 * Cloudflare-hosted, supports function calling and streaming, 131k context.
 */
export const DEFAULT_MODEL = "@cf/zai-org/glm-4.7-flash";

export const BACKUP_FORMAT = "talorys-backup";
export const BACKUP_VERSION = 1;

export const SESSION_COOKIE = "__Host-talorys_session";
export const DEV_SESSION_COOKIE = "talorys_session";

/** Header sent by the SPA on every API call. Simple-request CSRF can't set custom headers. */
export const CSRF_HEADER = "x-talorys-request";

export const GITHUB_URL = "https://github.com/rociiu/talorys";

export const DEFAULT_LIMITS = {
  maxOutputTokens: 1024,
  maxToolCalls: 10,
  maxAgentIterations: 8,
  maxContextTokens: 6000,
  maxScheduledAiRunsPerDay: 6,
  maxAiRequestsPerDay: 200,
} as const;

/** Memory history defaults: rule-based conflict detection on, AI double-check off. */
export const DEFAULT_MEMORY_HISTORY = {
  conflictReview: true,
  aiConflictCheck: false,
} as const;

/** Hard ceilings the owner cannot exceed through settings. */
export const LIMIT_CEILINGS = {
  maxOutputTokens: 4096,
  maxToolCalls: 20,
  maxAgentIterations: 10,
  maxContextTokens: 32000,
  maxScheduledAiRunsPerDay: 48,
  maxAiRequestsPerDay: 2000,
} as const;

// ---------- Entity vocabularies (plain arrays; the zod schemas in ./schemas build on them) ----------
export const TASK_STATUSES = ["todo", "in_progress", "done"] as const;
export const TASK_PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export const MEMORY_CATEGORIES = ["preference", "fact", "goal", "project", "habit", "person", "other"] as const;
export const PROJECT_STATUSES = ["active", "paused", "completed", "archived"] as const;
export const AUTOMATION_KINDS = ["reminder", "task_digest", "agent_prompt"] as const;
