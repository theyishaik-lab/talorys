import {
  type BridgeClientMessage,
  type BridgeServerMessage,
  DEVICE_BRIDGE_PROTOCOL,
  type DeviceCapability,
  type DeviceChatMessage,
  type DeviceErrorCode,
  type DeviceModelReport,
  modelReadiness,
  parseBridgeClientMessage,
} from "@talorys/shared";

/**
 * The device bridge (docs/local-models.md): the owner's phone keeps one WebSocket open to the agent's
 * Durable Object (`GET /api/device/bridge`, hibernation API, the app's native bearer token), reports
 * which on-device models it holds, and answers `generate` requests for chain entries
 * `{ provider: "device" }` by streaming tokens back.
 *
 * Everything per phone that must survive hibernation (who it is, what it reported) lives in the
 * connection's own state (serialized with the socket). Requests in flight live in memory: while a
 * chat turn waits on the phone the Durable Object is busy with that request and does not hibernate.
 *
 * The frames are generic on purpose: `command` / `result` carry the planned computer-use queue
 * (device_read_screen / device_act) later without another socket. Only `generate` is implemented.
 */

/** The part of an Agents SDK `Connection` the bridge uses (a fake in tests). */
export interface BridgeSocket {
  readonly id: string;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readonly state: BridgeConnState | null | undefined;
  setState(state: BridgeConnState): unknown;
}

/** Kept on the socket itself, so it survives the Durable Object hibernating between frames. */
export interface BridgeConnState {
  authed: boolean;
  connected_at: string;
  last_seen: string;
  device_id?: string;
  device_name?: string;
  app_version?: string;
  ram_bytes?: number;
  capabilities?: DeviceCapability[];
  models?: DeviceModelReport[];
}

/** One phone as Settings and chain status see it. */
export interface DeviceSummary {
  connection_id: string;
  device_id: string | null;
  device_name: string | null;
  app_version: string | null;
  connected_at: string;
  last_seen: string;
  models: DeviceModelReport[];
}

/** What the agent can say about running `model` on a phone right now. */
export type DeviceAvailability = { ok: true; socket: BridgeSocket } | { ok: false; reason: "device_offline" | "not_downloaded" | "not_allowed" | "low_memory" };

export type BridgeStreamEvent =
  | { kind: "accepted" }
  | { kind: "progress"; phase: "loading" | "prefill" | "thinking" }
  | { kind: "token"; delta: string }
  | { kind: "done"; usage?: { input_tokens?: number; output_tokens?: number }; backend?: "gpu" | "cpu" }
  | { kind: "error"; code: DeviceErrorCode; message: string }
  /** The phone's socket closed while the request was open. */
  | { kind: "closed" };

export interface GenerateOptions {
  model: string;
  system: string;
  messages: DeviceChatMessage[];
  maxOutputTokens: number;
  temperature?: number;
}

/** A live request: pull events with a timeout, cancel it. */
export interface BridgeRequest {
  readonly id: string;
  /** The next event, or "timeout" after `ms` without one. */
  next(ms: number): Promise<BridgeStreamEvent | "timeout">;
  cancel(): void;
}

export const BRIDGE_TAG = "device-bridge";

class EventQueue {
  private items: BridgeStreamEvent[] = [];
  private waiter: ((e: BridgeStreamEvent) => void) | null = null;

  push(e: BridgeStreamEvent): void {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(e);
    } else this.items.push(e);
  }

  next(ms: number): Promise<BridgeStreamEvent | "timeout"> {
    const head = this.items.shift();
    if (head) return Promise.resolve(head);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        resolve("timeout");
      }, ms);
      this.waiter = (e) => {
        clearTimeout(timer);
        resolve(e);
      };
    });
  }
}

export class DeviceBridge {
  private source: () => Iterable<BridgeSocket> = () => [];
  private readonly pending = new Map<string, { socketId: string; queue: EventQueue }>();
  private seq = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** Where the open bridge sockets come from (the agent's `getConnections(BRIDGE_TAG)`). */
  attach(source: () => Iterable<BridgeSocket>): void {
    this.source = source;
  }

  private sockets(): BridgeSocket[] {
    try {
      return [...this.source()].filter((s) => s.state?.authed);
    } catch (error) {
      console.error("device bridge: listing sockets failed", error);
      return [];
    }
  }

  /** A socket passed authentication (the agent checked its bearer token). */
  opened(socket: BridgeSocket): void {
    const at = new Date(this.now()).toISOString();
    socket.setState({ authed: true, connected_at: at, last_seen: at });
    this.send(socket, { type: "welcome", protocol: DEVICE_BRIDGE_PROTOCOL, server_time: at });
  }

  /** One text frame from a phone. Unknown or malformed frames are ignored. */
  message(socket: BridgeSocket, raw: string): void {
    const state = socket.state;
    if (!state?.authed) return;
    const msg = parseBridgeClientMessage(raw);
    if (!msg) return;
    const seen = { ...state, last_seen: new Date(this.now()).toISOString() };
    switch (msg.type) {
      case "hello":
        if (msg.protocol !== DEVICE_BRIDGE_PROTOCOL) {
          socket.close(4400, `Unsupported bridge protocol ${msg.protocol}; this agent speaks ${DEVICE_BRIDGE_PROTOCOL}.`);
          return;
        }
        socket.setState({
          ...seen,
          device_id: msg.device_id.slice(0, 80),
          device_name: msg.device_name?.slice(0, 80),
          app_version: msg.app_version?.slice(0, 40),
          ram_bytes: typeof msg.ram_bytes === "number" ? msg.ram_bytes : undefined,
          capabilities: msg.capabilities.filter((c): c is DeviceCapability => c === "generate" || c === "device_read_screen" || c === "device_act"),
          models: msg.models,
        });
        return;
      case "status":
        socket.setState({ ...seen, models: msg.models });
        return;
      case "pong":
        socket.setState(seen);
        return;
      default:
        this.route(socket, msg);
    }
  }

  private route(socket: BridgeSocket, msg: Exclude<BridgeClientMessage, { type: "hello" | "status" | "pong" }>): void {
    if (msg.type === "result") return; // computer-use commands: not implemented yet
    const p = this.pending.get(msg.id);
    if (!p || p.socketId !== socket.id) return;
    switch (msg.type) {
      case "accepted":
        p.queue.push({ kind: "accepted" });
        return;
      case "progress":
        p.queue.push({ kind: "progress", phase: msg.phase });
        return;
      case "token":
        p.queue.push({ kind: "token", delta: msg.delta });
        return;
      case "done":
        this.pending.delete(msg.id);
        p.queue.push({ kind: "done", usage: msg.usage, backend: msg.backend });
        return;
      case "error":
        this.pending.delete(msg.id);
        p.queue.push({ kind: "error", code: msg.code, message: msg.message });
        return;
    }
  }

  /** A phone's socket closed: every request it held ends. */
  closed(socket: BridgeSocket): void {
    for (const [id, p] of this.pending) {
      if (p.socketId !== socket.id) continue;
      this.pending.delete(id);
      p.queue.push({ kind: "closed" });
    }
  }

  /** The connected phones, newest report first. */
  devices(): DeviceSummary[] {
    return this.sockets()
      .map((s) => {
        const st = s.state as BridgeConnState;
        return {
          connection_id: s.id,
          device_id: st.device_id ?? null,
          device_name: st.device_name ?? null,
          app_version: st.app_version ?? null,
          connected_at: st.connected_at,
          last_seen: st.last_seen,
          models: st.models ?? [],
        };
      })
      .sort((a, b) => b.last_seen.localeCompare(a.last_seen));
  }

  /**
   * The phone to ask for `model`: one that reported it usable (a loaded model before one that must
   * load first, then the most recently heard from), else why none can.
   */
  availability(model: string): DeviceAvailability {
    const sockets = this.sockets().filter((s) => s.state?.device_id && (s.state.capabilities ?? []).includes("generate"));
    if (sockets.length === 0) return { ok: false, reason: "device_offline" };
    const rank = (s: BridgeSocket) => {
      const r = s.state?.models?.find((m) => m.id === model);
      return (r?.state === "ready" ? 2 : 1) * 1e13 + Date.parse(s.state?.last_seen ?? "") || 0;
    };
    const usable = sockets.filter((s) => modelReadiness(s.state?.models?.find((m) => m.id === model)) === "ok").sort((a, b) => rank(b) - rank(a));
    if (usable[0]) return { ok: true, socket: usable[0] };
    // Why not: the most telling reason any connected phone gives.
    const reasons = sockets.map((s) => modelReadiness(s.state?.models?.find((m) => m.id === model)));
    if (reasons.includes("not_allowed")) return { ok: false, reason: "not_allowed" };
    if (reasons.includes("low_memory")) return { ok: false, reason: "low_memory" };
    return { ok: false, reason: "not_downloaded" };
  }

  /** Sends a generate request to `socket`; the caller pulls its events and must finish or cancel it. */
  generate(socket: BridgeSocket, opts: GenerateOptions): BridgeRequest {
    const id = `g${this.now().toString(36)}${(++this.seq).toString(36)}`;
    const queue = new EventQueue();
    this.pending.set(id, { socketId: socket.id, queue });
    try {
      this.send(socket, { type: "generate", id, model: opts.model, system: opts.system, messages: opts.messages, max_output_tokens: opts.maxOutputTokens, ...(opts.temperature === undefined ? {} : { temperature: opts.temperature }) });
    } catch {
      this.pending.delete(id);
      queue.push({ kind: "closed" });
    }
    return {
      id,
      next: (ms) => queue.next(ms),
      cancel: () => {
        if (!this.pending.delete(id)) return;
        try {
          this.send(socket, { type: "cancel", id });
        } catch {
          /* the socket is gone; nothing to cancel */
        }
      },
    };
  }

  /** Requests still waiting on a phone (diagnostics, tests). */
  get inFlight(): number {
    return this.pending.size;
  }

  private send(socket: BridgeSocket, msg: BridgeServerMessage): void {
    socket.send(JSON.stringify(msg));
  }
}
