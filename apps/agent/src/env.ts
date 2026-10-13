import type { TalorysAgent } from "./agent/talorys-agent";

export interface Env {
  AI?: Ai;
  TalorysAgent: DurableObjectNamespace<TalorysAgent>;
  /** PBKDF2 hash of the owner password, set by the installer as a Worker secret. */
  OWNER_PASSWORD_HASH?: string;
  /** Plain owner password, for deploys that cannot set the hash (a one-Worker deploy). Ignored when the hash is set; a weak one counts as not configured. */
  OWNER_PASSWORD?: string;
  /** Random 256-bit secret used to key session token hashes. Worker secret. */
  SESSION_SECRET?: string;
  /** "development" enables local-only conveniences (mock AI, http cookies). Never set in production. */
  TALORYS_ENV?: string;
  /** Development only: use the deterministic mock AI provider. */
  TALORYS_MOCK_AI?: string;
  /** Development only: extra allowed origins (comma separated), e.g. the Vite dev server. */
  TALORYS_DEV_ORIGINS?: string;
  /** Installer defaults: the owner's timezone and chosen agent name. */
  TALORYS_DEFAULT_TIMEZONE?: string;
  TALORYS_AGENT_NAME?: string;
  /** Informational, written by the installer. */
  TALORYS_INSTALLATION_ID?: string;
  TALORYS_DEPLOYED_VERSION?: string;
  /** OpenConnector (optional): a service binding to the connector Worker in the same account … */
  OPEN_CONNECTOR?: Fetcher;
  /** … or its public URL when no binding is configured. */
  OPEN_CONNECTOR_URL?: string;
  /** OpenConnector runtime token. Worker secret; the connector tools are off without it. */
  OPEN_CONNECTOR_TOKEN?: string;
  /**
   * OpenConnector admin token. Worker secret; only the server-side connect step (after the owner's
   * Approve) uses it, never a tool result. Without it apps cannot be connected from the chat.
   * Needs OPEN_CONNECTOR_URL (the admin API is reached over the public URL).
   */
  OPEN_CONNECTOR_ADMIN_TOKEN?: string;
  /**
   * Web Push (VAPID). Both keys are Worker secrets set by the installer (one pair per install);
   * device notifications are off without them. The subject is the contact the push services see.
   */
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  /**
   * Native push for the Android app (apps/mobile): the Firebase service-account JSON, verbatim, as a
   * Worker secret. Messages go out through FCM HTTP v1 signed by the Worker. Off without it.
   */
  FCM_SERVICE_ACCOUNT?: string;
  /** Absolute origin notification deep links point at (the web app URL); defaults to the request origin. */
  PUBLIC_APP_URL?: string;
}
