/**
 * Talorys local models (docs/local-models.md): on-device LLMs (LiteRT-LM) the app downloads and runs,
 * and the phone's end of the agent's device bridge. Android only: elsewhere `TalorysLocalLlm` is null.
 */
import { Platform } from "react-native";
import { requireOptionalNativeModule } from "expo";

export type LocalModelState = "not_downloaded" | "downloading" | "downloaded" | "loading" | "ready" | "error";

export interface LocalModelStatus {
  id: string;
  name: string;
  sizeBytes: number;
  state: LocalModelState;
  downloadedBytes: number;
  /** RAM verdict for this phone: "block" refuses to load (Gemma 4 E4B needs ~6 GB). */
  ram: "ok" | "warn" | "block";
  useInChain: boolean;
  backend: "gpu" | "cpu" | null;
  error: string | null;
}

export interface LocalDeviceInfo {
  totalRamBytes: number;
  freeStorageBytes: number;
  abi: string;
}

export interface LocalModelSettings {
  /** Download only on Wi-Fi (default on). */
  wifiOnly: boolean;
  /** Keep the device bridge open while the keyboard companion runs in the foreground. */
  backgroundBridge: boolean;
  /** Answer locally in the chat when the agent is unreachable. */
  offlineFallback: boolean;
  /** Model for the offline fallback ("" = first downloaded). */
  offlineModel: string;
}

export interface DownloadProgressEvent {
  id: string;
  downloadedBytes: number;
  totalBytes: number;
  phase: "downloading" | "verifying" | "done" | "paused" | "error";
  error: string | null;
}

export interface TokenEvent {
  requestId: string;
  delta?: string;
  phase?: "loading" | "prefill" | "thinking";
}

export type BridgeState = "off" | "connecting" | "connected" | "error" | "unauthorized";

export interface LocalChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface Subscription {
  remove(): void;
}

export interface TalorysLocalLlmModule {
  getModels(): LocalModelStatus[];
  getDeviceInfo(): LocalDeviceInfo;
  getSettings(): LocalModelSettings;
  setSettings(values: Partial<LocalModelSettings>): LocalModelSettings;
  startDownload(id: string): void;
  pauseDownload(id: string): void;
  deleteModel(id: string): Promise<LocalModelStatus>;
  setUseInChain(id: string, on: boolean): LocalModelStatus;
  load(id: string): Promise<LocalModelStatus>;
  unload(): void;
  /** Tokens arrive as onToken events; resolves at the end. Rejects with code ERR_CANCELLED, ERR_NOT_DOWNLOADED, ERR_LOW_MEMORY, ERR_BUSY, … */
  generate(requestId: string, id: string, system: string, messages: LocalChatMessage[], maxOutputTokens: number): Promise<{ text: string; backend: "gpu" | "cpu" }>;
  cancel(requestId: string): void;
  setSession(server: string | null, token: string | null): void;
  setForeground(active: boolean): void;
  getBridgeState(): { state: BridgeState; detail: string | null };
  addListener(event: "onDownloadProgress", fn: (e: DownloadProgressEvent) => void): Subscription;
  addListener(event: "onModelState", fn: (e: LocalModelStatus) => void): Subscription;
  addListener(event: "onToken", fn: (e: TokenEvent) => void): Subscription;
  addListener(event: "onBridgeState", fn: (e: { state: BridgeState; detail: string | null }) => void): Subscription;
}

export const TalorysLocalLlm: TalorysLocalLlmModule | null = Platform.OS === "android" ? requireOptionalNativeModule<TalorysLocalLlmModule>("TalorysLocalLlm") : null;

export function isLocalLlmAvailable(): boolean {
  return TalorysLocalLlm != null;
}
