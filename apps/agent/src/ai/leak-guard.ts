/**
 * Guard for model output that leaks tool-call markup into the visible answer or loops.
 *
 * Some Workers AI models (glm-4.7-flash, granite, qwen) occasionally write a tool call as
 * text — `<tool_call>search_actions<arg_key>query</arg_key><arg_value>…</arg_value></tool_call>`
 * — instead of returning a structured call, and some repeat the same sentence on every step
 * of a tool loop. `LeakGuard` filters the streamed text: it hides everything from a tool-call
 * marker to the end of that step (keeping it for `parseLeakedToolCalls`), drops a line that
 * repeats the line just before it and a step whose whole text repeats an earlier step, and
 * flags `looping` once the repetition is clearly stuck so the caller can stop the turn.
 */

/** Openers of tool-call markup that must never reach the owner. */
export const LEAK_MARKERS = ["<tool_call>", "<tool_calls>", "<|tool_call", "<function=", "[TOOL_CALLS]", "<|python_tag|>", "<arg_key>"] as const;

/** Repeats shorter than this (after whitespace collapse) are never treated as loops. */
const MIN_REPEAT = 8;
/** A line repeated back to back this many extra times means the model is stuck. */
const LINE_REPEATS_TO_STOP = 2;
/** A whole step repeated this many extra times means the tool loop is stuck. */
const STEP_REPEATS_TO_STOP = 3;

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

export interface LeakedCall {
  name: string;
  input: Record<string, unknown>;
}

function firstMarker(text: string): number {
  let best = -1;
  for (const m of LEAK_MARKERS) {
    const i = text.indexOf(m);
    if (i !== -1 && (best === -1 || i < best)) best = i;
  }
  return best;
}

/** Length of the longest suffix of `text` that is a proper prefix of a marker (held back until it resolves). */
function partialMarkerSuffix(text: string): number {
  let keep = 0;
  for (const m of LEAK_MARKERS) {
    for (let k = Math.min(m.length - 1, text.length); k > keep; k--) {
      if (m.startsWith(text.slice(text.length - k))) {
        keep = k;
        break;
      }
    }
  }
  return keep;
}

export class LeakGuard {
  /** Set once repetition shows the model is stuck; the caller should stop the turn. */
  looping = false;
  /** Every character actually released for display, across all steps. */
  emitted = "";
  /** Released text since the last `markToolActivity()`, i.e. what the owner reads as the answer. */
  emittedSinceTools = "";

  private markerHold = "";
  private capturing = false;
  private stepLeak = "";
  private leaks: string[] = [];
  private stepClean = "";
  private pending = "";
  private lineOut = "";
  private prevLine: string | null = null;
  private lineRepeats = 0;
  private readonly stepTexts = new Set<string>();
  private stepRepeats = 0;
  private leakNameHint: string | undefined;

  /** Feeds one streamed text delta; returns the part that is safe to show now. */
  push(delta: string): string {
    if (this.looping || !delta) return "";
    if (this.capturing) {
      this.stepLeak += delta;
      return "";
    }
    let text = this.markerHold + delta;
    this.markerHold = "";
    const at = firstMarker(text);
    if (at !== -1) {
      this.capturing = true;
      this.stepLeak = text.slice(at);
      text = text.slice(0, at);
      if (this.stepLeak.startsWith("<arg_key>")) this.leakNameHint = /([A-Za-z_][\w.-]*)\s*$/.exec(this.stepClean + text)?.[1];
    } else {
      const keep = partialMarkerSuffix(text);
      if (keep > 0) {
        this.markerHold = text.slice(text.length - keep);
        text = text.slice(0, text.length - keep);
      }
    }
    return this.release(text, false);
  }

  /** Ends a model step: flushes held text (unless the step only repeated an earlier one). */
  endStep(): string {
    let out = "";
    if (!this.capturing && this.markerHold) {
      this.stepClean += this.markerHold;
      this.pending += this.markerHold;
    }
    this.markerHold = "";
    const whole = norm(this.stepClean);
    if (!this.looping && whole.length >= MIN_REPEAT && this.stepTexts.has(whole)) {
      this.stepRepeats++;
      if (this.stepRepeats >= STEP_REPEATS_TO_STOP) this.looping = true;
    } else if (!this.looping) {
      out = this.drain(true);
    }
    if (whole) this.stepTexts.add(whole);
    if (this.stepLeak) this.leaks.push(this.stepLeak);
    this.stepLeak = "";
    this.capturing = false;
    this.stepClean = "";
    this.pending = "";
    this.lineOut = "";
    this.prevLine = null;
    this.lineRepeats = 0;
    this.record(out);
    return out;
  }

  /** Tool-call markup hidden since the last call, joined; empty when nothing leaked. */
  takeLeaks(): { text: string; nameHint?: string } {
    const text = this.leaks.join("\n");
    const nameHint = this.leakNameHint;
    this.leaks = [];
    this.leakNameHint = undefined;
    return { text, nameHint };
  }

  /** Call when a tool ran, so `emittedSinceTools` measures the answer that follows it. */
  markToolActivity(): void {
    this.emittedSinceTools = "";
  }

  private release(text: string, final: boolean): string {
    if (!text) return "";
    this.stepClean += text;
    this.pending += text;
    const out = this.drain(final);
    this.record(out);
    return out;
  }

  private record(out: string) {
    this.emitted += out;
    this.emittedSinceTools += out;
  }

  /** True while this step's text could still turn out to be a copy of an earlier step. */
  private mirrorsEarlierStep(): boolean {
    const s = norm(this.stepClean);
    if (!s) return false;
    for (const k of this.stepTexts) if (k.length >= MIN_REPEAT && k.startsWith(s)) return true;
    return false;
  }

  private drain(final: boolean): string {
    if (!final && this.mirrorsEarlierStep()) return "";
    let out = "";
    let nl: number;
    while (!this.looping && (nl = this.pending.indexOf("\n")) !== -1) {
      out += this.finishLine(this.pending.slice(0, nl), "\n");
      this.pending = this.pending.slice(nl + 1);
    }
    if (this.looping) {
      this.pending = "";
      return out;
    }
    if (final) {
      if (this.pending) out += this.finishLine(this.pending, "");
      this.pending = "";
    } else if (this.pending) {
      const partial = norm(this.lineOut + this.pending);
      const holding = this.lineOut === "" && this.prevLine !== null && this.prevLine.length >= MIN_REPEAT && this.prevLine.startsWith(partial);
      if (!holding) {
        out += this.pending;
        this.lineOut += this.pending;
        this.pending = "";
      }
    }
    return out;
  }

  private finishLine(rest: string, nl: string): string {
    const full = norm(this.lineOut + rest);
    const alreadyShown = this.lineOut !== "";
    this.lineOut = "";
    if (!full) return rest + nl;
    if (!alreadyShown && full === this.prevLine && full.length >= MIN_REPEAT) {
      this.lineRepeats++;
      if (this.lineRepeats >= LINE_REPEATS_TO_STOP) this.looping = true;
      return "";
    }
    this.lineRepeats = 0;
    this.prevLine = full;
    return rest + nl;
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      return asObject(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Parses JSON, tolerating trailing junk after the last closing brace or bracket. */
function looseJson(text: string): unknown {
  const t = text.trim();
  try {
    return JSON.parse(t);
  } catch {
    const end = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
    if (end <= 0) return undefined;
    try {
      return JSON.parse(t.slice(0, end + 1));
    } catch {
      return undefined;
    }
  }
}

function argValue(raw: string): unknown {
  const v = raw.trim();
  if (/^(\{|\[|"|-?\d|true$|false$|null$)/.test(v)) {
    try {
      return JSON.parse(v);
    } catch {
      /* plain string */
    }
  }
  return v;
}

function fromJsonCall(value: unknown): LeakedCall[] {
  const list = Array.isArray(value) ? value : [value];
  const calls: LeakedCall[] = [];
  for (const item of list) {
    const obj = asObject(item);
    if (!obj) continue;
    const fn = asObject(obj.function);
    const name = typeof obj.name === "string" ? obj.name : typeof fn?.name === "string" ? (fn.name as string) : null;
    if (!name) continue;
    const rawArgs = obj.arguments ?? obj.parameters ?? obj.input ?? obj.args ?? fn?.arguments;
    let input = asObject(rawArgs);
    if (!input && rawArgs === undefined) {
      const { name: _n, type: _t, function: _f, id: _i, ...rest } = obj;
      input = rest;
    }
    if (input) calls.push({ name, input });
  }
  return calls;
}

function pairs(body: string, re: RegExp): Record<string, unknown> | null {
  const input: Record<string, unknown> = {};
  let found = false;
  for (const m of body.matchAll(re)) {
    const key = m[1]!.trim();
    if (!key) continue;
    input[key] = argValue(m[2] ?? "");
    found = true;
  }
  return found ? input : null;
}

const GLM_ARGS = /<arg_key>([\s\S]*?)<\/arg_key>\s*<arg_value>([\s\S]*?)(?:<\/arg_value>|$)/g;
const PARAM_ARGS = /<parameter=([\w.-]+)>([\s\S]*?)(?:<\/parameter>|$)/g;

function parseBlock(block: string, nameHint?: string): LeakedCall[] {
  if (block.startsWith("<tool_call>") || block.startsWith("<tool_calls>")) {
    const body = block.replace(/^<tool_calls?>/, "").split(/<\/tool_calls?>/)[0]!.trim();
    if (body.startsWith("{") || body.startsWith("[")) return fromJsonCall(looseJson(body));
    const name = /^([A-Za-z_][\w.-]*)/.exec(body)?.[1];
    if (!name) return [];
    const input = pairs(body, GLM_ARGS) ?? pairs(body, PARAM_ARGS);
    if (input) return [{ name, input }];
    const rest = body.slice(name.length).trim();
    if (!rest) return [{ name, input: {} }];
    const json = asObject(looseJson(rest));
    return json ? [{ name, input: json }] : [];
  }
  if (block.startsWith("<function=")) {
    const m = /^<function=([\w.-]+)>([\s\S]*?)(?:<\/function>|$)/.exec(block);
    if (!m) return [];
    const body = m[2]!.trim();
    const input = body.startsWith("{") ? asObject(looseJson(body)) : (pairs(body, PARAM_ARGS) ?? (body ? null : {}));
    return input ? [{ name: m[1]!, input }] : [];
  }
  if (block.startsWith("[TOOL_CALLS]")) {
    const body = block.slice("[TOOL_CALLS]".length).trim();
    const named = /^([A-Za-z_][\w.-]*)\s*\[ARGS\]([\s\S]*)$/.exec(body);
    if (named) {
      const input = asObject(looseJson(named[2]!));
      return input ? [{ name: named[1]!, input }] : [];
    }
    return fromJsonCall(looseJson(body));
  }
  if (block.startsWith("<|python_tag|>")) return fromJsonCall(looseJson(block.slice("<|python_tag|>".length)));
  if (block.startsWith("<|tool_call")) {
    const start = block.search(/[[{]/);
    return start === -1 ? [] : fromJsonCall(looseJson(block.slice(start).split("<|")[0]!));
  }
  if (block.startsWith("<arg_key>") && nameHint) {
    const input = pairs(block, GLM_ARGS);
    return input ? [{ name: nameHint, input }] : [];
  }
  return [];
}

/**
 * Reads tool calls out of leaked markup. Only calls to tools in `known` with an object input
 * are returned; anything unparseable is ignored (the caller then ends the turn gracefully).
 */
export function parseLeakedToolCalls(text: string, known: ReadonlySet<string>, nameHint?: string): LeakedCall[] {
  const calls: LeakedCall[] = [];
  let rest = text;
  while (rest) {
    const at = firstMarker(rest);
    if (at === -1) break;
    rest = rest.slice(at);
    const marker = LEAK_MARKERS.find((m) => rest.startsWith(m))!;
    const next = firstMarker(rest.slice(marker.length));
    let block = next === -1 ? rest : rest.slice(0, marker.length + next);
    // GLM argument pairs belong to the call that opened them.
    if (marker !== "<arg_key>" && next !== -1 && rest.slice(marker.length + next).startsWith("<arg_key>")) {
      const close = rest.search(/<\/tool_call>|<\/function>/);
      block = close === -1 ? rest : rest.slice(0, close + 12);
    }
    calls.push(...parseBlock(block, nameHint));
    rest = rest.slice(Math.max(block.length, marker.length));
  }
  return calls.filter((c) => known.has(c.name));
}

/** The owner's language decides the wording of the graceful stop. */
export function gracefulStopText(lastUserMessage: string): string {
  return /[\u0590-\u05FF]/.test(lastUserMessage)
    ? "לא הצלחתי להשלים את הבקשה הפעם. אפשר לנסות שוב או לנסח אותה בצורה ממוקדת יותר."
    : "I couldn't finish that request this time. Please try again or ask for something more specific.";
}
