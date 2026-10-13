export const TALORYS_VERSION = "0.1.5";

/** Stable identity of the single owner's agent inside the private DO namespace. */
export const AGENT_INSTANCE_NAME = "personal-agent";

/**
 * Default Workers AI model. Verified on developers.cloudflare.com/workers-ai/models:
 * Cloudflare-hosted, supports function calling and streaming, 131k context.
 */
export const DEFAULT_MODEL = "@cf/zai-org/glm-4.7-flash";

/** Where to get an API key for each non-Cloudflare provider (shown in Settings → Model). */
export const PROVIDER_KEY_URLS = {
  gemini: "https://aistudio.google.com/app/apikey",
  openrouter: "https://openrouter.ai/settings/keys",
} as const;

/**
 * Gemini models shown before a key is stored (the live list replaces it once a key exists).
 * From ai.google.dev/gemini-api/docs/models on Oct 13, 2026: the 2.5 generation is limited to
 * accounts that already used it; new projects get 3.x.
 */
export const GEMINI_STATIC_MODELS = ["gemini-3.5-flash", "gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite"] as const;

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

/**
 * Hard ceilings the owner cannot exceed through settings — set to what the models and the Workers
 * runtime technically allow (Oct 13, 2026), not to a budget. The agent clamps per model at run
 * time, so a ceiling above what one model takes never breaks a request:
 *  - maxOutputTokens: the largest output any supported model takes (OpenRouter's Nemotron 3 Super
 *    lists 235,929; Gemini 3.x 65,536); each provider is clamped to its model's own maximum.
 *  - maxContextTokens: Gemini's 1,048,576-token window; the history is cut to the smallest window
 *    in the fallback chain (see apps/agent/src/ai/model-caps.ts).
 *  - maxToolCalls / maxAgentIterations: per turn. On the Workers Free plan one invocation may make
 *    50 subrequests (each model step and each connector call is one), and the runner stops a turn
 *    before that wall (TALORYS_SUBREQUEST_LIMIT); on Workers Paid the wall is 10,000.
 *  - maxScheduledAiRunsPerDay: one AI automation run per minute, all day.
 *  - maxAiRequestsPerDay: the Workers Free plan's 100,000 requests a day.
 */
export const LIMIT_CEILINGS = {
  maxOutputTokens: 262_144,
  maxToolCalls: 500,
  maxAgentIterations: 200,
  maxContextTokens: 1_048_576,
  maxScheduledAiRunsPerDay: 1440,
  maxAiRequestsPerDay: 100_000,
} as const;

// ---------- Entity vocabularies (plain arrays; the zod schemas in ./schemas build on them) ----------
export const TASK_STATUSES = ["todo", "in_progress", "done"] as const;
export const TASK_PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export const MEMORY_CATEGORIES = ["preference", "fact", "goal", "project", "habit", "person", "other"] as const;
export const PROJECT_STATUSES = ["active", "paused", "completed", "archived"] as const;
export const AUTOMATION_KINDS = ["reminder", "task_digest", "agent_prompt"] as const;
