import { type KeyboardEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import type { ChatMessage, Conversation, PendingAction, ToolActivity } from "@talorys/shared";
import {
  AlertTriangle,
  ArrowUp,
  Bell,
  Calendar,
  Check,
  CheckCircle2,
  CheckSquare,
  Copy,
  Folder,
  ListChecks,
  Loader2,
  Mail,
  RotateCcw,
  ShieldCheck,
  Sparkle,
  Square,
  SquarePen,
  XCircle,
} from "lucide-react";
import { BellButton, MenuButton, IconButton, TopBar } from "../components/AppShell";
import { ChatUsage } from "../components/ChatUsage";
import { ConnectCard } from "../components/ConnectCard";
import { Markdown } from "../components/Markdown";
import { Button, Spinner } from "../components/ui";
import { keys, useApiMutation, useAutomations, useConversation, useSettings, useTasks } from "../hooks/queries";
import { api, ApiError, streamChat } from "../lib/api";
import { cn, copyText } from "../lib/utils";
import { type StringKey, useT } from "../lib/i18n";

interface StreamState {
  conversationId: string | null;
  userText: string;
  assistantId: string | null;
  text: string;
  tools: ToolActivity[];
  error: string | null;
  done: boolean;
}

const TILES: { title: StringKey; sub: StringKey; prompt: StringKey; icon: typeof Mail }[] = [
  { title: "home.tile1.title", sub: "home.tile1.sub", prompt: "home.tile1.prompt", icon: Mail },
  { title: "home.tile2.title", sub: "home.tile2.sub", prompt: "home.tile2.prompt", icon: Calendar },
  { title: "home.tile3.title", sub: "home.tile3.sub", prompt: "home.tile3.prompt", icon: ListChecks },
  { title: "home.tile4.title", sub: "home.tile4.sub", prompt: "home.tile4.prompt", icon: Folder },
];

export function ChatPage() {
  const { conversationId } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const t = useT();
  const settings = useSettings();
  const conversation = useConversation(conversationId);
  const [stream, setStream] = useState<StreamState | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const messages = conversation.data?.messages ?? [];
  const streaming = !!stream && !stream.done;
  // The local stream may belong to a conversation the owner navigated away from; only render it in its own.
  const streamHere = stream && stream.conversationId === (conversationId ?? null) ? stream : null;
  // A reply generating server-side that this page isn't streaming (started before a reload or in another tab).
  const remoteStreaming = !streamHere && !!conversation.data?.streaming;

  // Reset transient stream state when switching conversations (unless it belongs to the new one).
  useEffect(() => {
    setStream((s) => (s && s.conversationId === (conversationId ?? null) ? s : streaming ? s : null));
    stickToBottom.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, stream?.text, stream?.tools.length, stream?.error]);

  async function send(text: string, opts: { retry?: boolean } = {}) {
    if (streaming) return;
    const controller = new AbortController();
    abortRef.current = controller;
    stickToBottom.current = true;
    let convId = conversationId ?? null;
    if (opts.retry && convId) {
      // Optimistically hide the failed reply that the server is about to replace.
      qc.setQueryData<{ conversation: Conversation; messages: ChatMessage[] }>(keys.conversation(convId), (old) =>
        old ? { ...old, messages: old.messages.filter((m) => !(m.role === "assistant" && m.status !== "complete" && m === old.messages.at(-1))) } : old,
      );
    }
    setStream({ conversationId: convId, userText: opts.retry ? "" : text, assistantId: null, text: "", tools: [], error: null, done: false });
    try {
      await streamChat(
        { conversation_id: convId ?? undefined, message: opts.retry ? "retry" : text, retry: opts.retry },
        (event) => {
          switch (event.type) {
            case "title":
              void qc.invalidateQueries({ queryKey: ["conversations"] });
              break;
            case "start":
              if (!convId) {
                convId = event.conversation_id;
                navigate(`/chat/${convId}`, { replace: true });
              }
              setStream((s) => s && { ...s, conversationId: event.conversation_id, assistantId: event.assistant_message_id });
              break;
            case "text":
              setStream((s) => s && { ...s, text: s.text + event.delta });
              break;
            case "tool":
              setStream((s) => {
                if (!s) return s;
                const tools = s.tools.some((t) => t.id === event.tool.id)
                  ? s.tools.map((t) => (t.id === event.tool.id ? event.tool : t))
                  : [...s.tools, event.tool];
                return { ...s, tools };
              });
              break;
            case "error":
              setStream((s) => s && { ...s, error: event.message });
              break;
            case "done": {
              const id = event.message.conversation_id;
              void qc
                .invalidateQueries({ queryKey: keys.conversation(id) })
                .then(() => setStream((s) => (s && s.assistantId === event.message.id ? null : s)));
              setStream((s) => s && { ...s, done: true });
              break;
            }
          }
        },
        controller.signal,
      );
    } catch (error) {
      if (controller.signal.aborted) {
        setStream((s) => s && { ...s, done: true });
      } else {
        const message = error instanceof ApiError || error instanceof Error ? error.message : t("chat.connectionLost");
        setStream((s) => s && { ...s, error: message, done: true });
      }
    } finally {
      abortRef.current = null;
      void qc.invalidateQueries({ queryKey: ["conversations"] });
      void qc.invalidateQueries({ queryKey: keys.usage });
      if (convId) void qc.invalidateQueries({ queryKey: keys.conversation(convId) });
      // Drop the transient bubble once persisted messages are back.
      setTimeout(() => setStream((s) => (s?.done ? null : s)), 400);
    }
  }

  function stop() {
    const convId = stream?.conversationId ?? (remoteStreaming ? conversationId : null);
    abortRef.current?.abort();
    if (convId) void api("/chat/cancel", { method: "POST", body: { conversation_id: convId } }).catch(() => {});
  }

  const lastFailed = useMemo(() => {
    const last = messages.at(-1);
    return last && last.role === "assistant" && last.status === "error" ? last : null;
  }, [messages]);

  const showEmpty = !conversationId && !streamHere;

  return (
    <section className="flex h-full min-w-0 flex-col">
      <ChatHeader conversation={conversation.data?.conversation} name={settings.data?.agentName ?? "Talorys"} onNew={() => navigate("/chat")} />

      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        className="scrollbar-thin min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        {showEmpty ? (
          <EmptyChat name={settings.data?.agentName ?? "Talorys"} onPick={(s) => void send(s)} />
        ) : conversation.isLoading && !streamHere ? (
          <div className="flex justify-center py-16">
            <Spinner />
          </div>
        ) : conversation.isError && !streamHere ? (
          <div className="p-8 text-center text-sm text-fg-muted">{t("chat.loadFailed")}</div>
        ) : (
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 pb-4 pt-2 md:px-6">
            {messages.map((m) =>
              stream && stream.assistantId === m.id ? null : (
                <MessageView
                  key={m.id}
                  message={m}
                  onRetry={lastFailed?.id === m.id && !streaming && !remoteStreaming ? () => void send("", { retry: true }) : undefined}
                />
              ),
            )}
            {streamHere && (
              <>
                {streamHere.userText && !messages.some((m) => m.role === "user" && m.content === streamHere.userText && streamHere.done) && (
                  <UserBubble text={streamHere.userText} />
                )}
                <AssistantBubble
                  text={streamHere.text}
                  tools={streamHere.tools}
                  error={streamHere.error}
                  streaming={!streamHere.done}
                  onRetry={streamHere.error && streamHere.done && conversationId ? () => void send("", { retry: true }) : undefined}
                />
              </>
            )}
            {remoteStreaming && <AssistantBubble text="" tools={[]} error={null} streaming />}
          </div>
        )}
      </div>

      <Composer name={settings.data?.agentName ?? "Talorys"} streaming={streaming || remoteStreaming} onSend={(text) => void send(text)} onStop={stop} autoFocus={showEmpty} />
    </section>
  );
}

function ChatHeader({ conversation, name, onNew }: { conversation?: Conversation; name: string; onNew: () => void }) {
  const t = useT();
  return (
    <TopBar
      start={<MenuButton />}
      title={
        conversation ? (
          <div className="flex flex-col items-center leading-tight">
            <h2 className="w-full truncate text-[16px] font-semibold text-fg" dir="auto">
              {conversation.title}
            </h2>
            <span className="text-xs text-fg-muted">{name}</span>
          </div>
        ) : (
          <span className="text-[15px] font-semibold uppercase tracking-[0.14em]">{name}</span>
        )
      }
      end={
        <>
          <ChatUsage />
          <BellButton />
          <IconButton onClick={onNew} label={t("chat.newConversation")}>
            <SquarePen className="h-5 w-5" />
          </IconButton>
        </>
      }
    />
  );
}

/** Home: greeting, what today looks like, and four things to try — above the composer. */
function EmptyChat({ name, onPick }: { name: string; onPick: (s: string) => void }) {
  const t = useT();
  const tasks = useTasks();
  const automations = useAutomations();
  const greeting = (() => {
    const h = new Date().getHours();
    return t(h < 12 ? "chat.goodMorning" : h < 18 ? "chat.goodAfternoon" : "chat.goodEvening");
  })();
  const openTasks = tasks.data?.filter((x) => x.status !== "done").length;
  const activeAutomations = automations.data?.automations.filter((a) => a.enabled).length;
  const chips: { icon: typeof Mail; text: string }[] = [];
  if (openTasks !== undefined) chips.push({ icon: CheckSquare, text: openTasks ? t("home.openTasks", { n: openTasks }) : t("home.noOpenTasks") });
  if (activeAutomations) chips.push({ icon: Bell, text: t("home.automations", { n: activeAutomations }) });

  return (
    <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col px-6 pb-4 animate-fade-in">
      <div className="pt-12 md:pt-20">
        <div className="mb-5 grid h-11 w-11 place-items-center rounded-[14px] bg-fg text-bg" aria-hidden>
          <Sparkle className="h-[22px] w-[22px]" />
        </div>
        <h1 className="text-[30px] font-semibold leading-tight tracking-[-0.01em] text-fg md:text-4xl">{greeting}</h1>
        <p className="mt-1.5 text-[17px] text-fg-muted">{t("chat.prompt")}</p>
        {chips.length > 0 && (
          <div className="mt-6 flex flex-wrap gap-2">
            {chips.map((c) => (
              <span key={c.text} className="inline-flex items-center gap-1.5 rounded-full border border-border bg-subtle px-2.5 py-1 text-[13px] text-fg-muted">
                <c.icon className="h-3.5 w-3.5" />
                {c.text}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="mt-auto grid grid-cols-2 gap-2 pt-10">
        {TILES.map((tile) => (
          <button
            type="button"
            key={tile.title}
            onClick={() => onPick(t(tile.prompt))}
            className="pressable min-h-[76px] rounded-xl border border-border bg-subtle px-3.5 py-3 text-start hover:border-border-strong"
          >
            <tile.icon className="mb-2 h-[18px] w-[18px] text-fg-muted" />
            <span className="block text-sm font-medium leading-[1.35] text-fg">{t(tile.title)}</span>
            <span className="mt-0.5 block text-[12.5px] text-fg-muted">{t(tile.sub)}</span>
          </button>
        ))}
      </div>
      <p className="mt-2 hidden text-center text-[11px] text-fg-subtle md:block">{t("chat.footer", { name })}</p>
    </div>
  );
}

function MessageView({ message, onRetry }: { message: ChatMessage; onRetry?: () => void }) {
  if (message.role === "user") return <UserBubble text={message.content} />;
  return (
    <AssistantBubble
      text={message.content}
      tools={message.tools}
      error={message.status === "error" ? message.error : null}
      cancelled={message.status === "cancelled"}
      streaming={false}
      onRetry={onRetry}
    />
  );
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end animate-fade-in">
      <div dir="auto" className="max-w-[80%] whitespace-pre-wrap break-words rounded-[20px] rounded-ee-md bg-bubble-user px-3.5 py-2.5 text-[15px] leading-6 text-bubble-user-fg">
        {text}
      </div>
    </div>
  );
}

function ToolChip({ tool }: { tool: ToolActivity }) {
  return (
    <span
      title={tool.error}
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-[13px]",
        tool.status === "error" ? "border-danger/30 bg-danger-soft text-danger" : "border-border bg-subtle text-fg-muted",
      )}
    >
      {tool.status === "running" ? (
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
      ) : tool.status === "success" ? (
        <Check className="h-3.5 w-3.5 shrink-0 text-success" />
      ) : (
        <XCircle className="h-3.5 w-3.5 shrink-0" />
      )}
      <span className="truncate" dir="auto">
        {tool.label}
      </span>
    </span>
  );
}

const APPROVAL_DONE: Record<Exclude<PendingAction["status"], "pending">, StringKey> = {
  approved: "chat.approved",
  cancelled: "chat.declined",
  expired: "chat.expired",
  failed: "chat.approvalFailed",
};

/** The only way a destructive action proposed by the agent can run. */
function ApprovalCard({ action: initial }: { action: PendingAction }) {
  if (initial.card?.kind === "connect") return <ConnectCard action={{ ...initial, card: initial.card }} />;
  return <PlainApprovalCard action={initial} />;
}

function PlainApprovalCard({ action: initial }: { action: PendingAction }) {
  const qc = useQueryClient();
  const t = useT();
  const [action, setAction] = useState(initial);
  useEffect(() => setAction(initial), [initial]);
  const decide = useApiMutation(
    (decision: "approve" | "cancel") =>
      api<{ action: PendingAction }>(`/actions/${action.id}/${decision}`, { method: "POST", body: {} }).catch((error: unknown) => {
        // Already handled or expired elsewhere: show the current state.
        void qc.invalidateQueries({ queryKey: ["conversation"] });
        throw error;
      }),
    {
      invalidate: [["conversation"], keys.tasks, ["notes"], ["memories"], keys.automations],
      onSuccess: (r) => setAction(r.action),
    },
  );
  const status = action.status === "pending" && Date.parse(action.expires_at) <= Date.now() ? "expired" : action.status;

  if (status !== "pending") {
    return (
      <div className="flex items-start gap-2 rounded-xl border border-border bg-subtle px-3 py-2 text-sm text-fg-muted">
        {status === "approved" ? (
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
        ) : (
          <XCircle className={cn("mt-0.5 h-4 w-4 shrink-0", status === "failed" && "text-danger")} />
        )}
        <span className="min-w-0 break-words">
          <span className="text-fg" dir="auto">
            {action.summary}
          </span>{" "}
          · {t(APPROVAL_DONE[status])}
          {status === "failed" && action.error ? `: ${action.error}` : ""}
        </span>
      </div>
    );
  }
  return (
    <div role="group" aria-label={t("chat.approvalNeeded")} className="overflow-hidden rounded-2xl border border-border bg-surface shadow-card">
      <div className="flex items-start gap-3 px-4 pb-3 pt-3.5">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-accent-soft text-accent-text" aria-hidden>
          <ShieldCheck className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="break-words text-[15px] font-semibold leading-snug text-fg" dir="auto">
            {action.summary}
          </p>
          <p className="mt-0.5 text-[12.5px] text-fg-muted">{t("chat.approvalHint")}</p>
        </div>
        <span className="shrink-0 rounded-full bg-warning/12 px-2 py-0.5 text-[11.5px] font-semibold text-warning">{t("chat.awaiting")}</span>
      </div>
      <div className="flex gap-2 px-4 pb-3.5">
        <Button className="flex-1 justify-center" loading={decide.isPending && decide.variables === "approve"} disabled={decide.isPending} onClick={() => decide.mutate("approve")}>
          <Check className="h-4 w-4" /> {t("chat.approve")}
        </Button>
        <Button variant="secondary" className="flex-1 justify-center" disabled={decide.isPending} onClick={() => decide.mutate("cancel")}>
          {t("chat.decline")}
        </Button>
      </div>
    </div>
  );
}

function AssistantBubble({
  text,
  tools,
  error,
  streaming,
  cancelled,
  onRetry,
}: {
  text: string;
  tools: ToolActivity[];
  error: string | null;
  streaming: boolean;
  cancelled?: boolean;
  onRetry?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const t = useT();
  return (
    <div className="group flex min-w-0 flex-col gap-2.5 animate-fade-in">
      {tools.length > 0 && (
        <div role="group" className="flex flex-wrap gap-1.5" aria-label={t("chat.actionsTaken")}>
          {tools.map((tool) => (
            <ToolChip key={tool.id} tool={tool} />
          ))}
        </div>
      )}
      {text ? (
        <Markdown content={text} />
      ) : streaming && tools.every((tool) => tool.status !== "running") ? (
        <div role="status" className="flex h-7 items-center gap-1" aria-label={t("chat.thinking")}>
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-fg-subtle" />
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-fg-subtle [animation-delay:150ms]" />
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-fg-subtle [animation-delay:300ms]" />
        </div>
      ) : null}
      {tools.map((tool) => tool.approval && <ApprovalCard key={tool.approval.id} action={tool.approval} />)}
      {cancelled && <p className="text-xs text-fg-subtle">{t("chat.stopped")}</p>}
      {error && (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-xl border border-danger/25 bg-danger-soft px-3 py-2 text-sm text-danger">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span className="flex-1" dir="auto">
            {error}
          </span>
          {onRetry && (
            <button type="button" onClick={onRetry} className="inline-flex items-center gap-1 font-medium underline-offset-2 hover:underline">
              <RotateCcw className="h-3.5 w-3.5" /> {t("common.retry")}
            </button>
          )}
        </div>
      )}
      {!streaming && text && (
        <div className="-mt-1.5 flex gap-1 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100">
          <button
            type="button"
            onClick={() =>
              void copyText(text).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              })
            }
            className="pressable inline-flex items-center gap-1 rounded-md p-1.5 text-xs text-fg-subtle hover:bg-subtle hover:text-fg"
            aria-label={t("chat.copyResponse")}
            title={t("common.copy")}
          >
            {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
            {copied && t("common.copied")}
          </button>
        </div>
      )}
    </div>
  );
}

function Composer({ name, streaming, onSend, onStop, autoFocus }: { name: string; streaming: boolean; onSend: (t: string) => void; onStop: () => void; autoFocus?: boolean }) {
  const t = useT();
  const [value, setValue] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);

  function submit() {
    const text = value.trim();
    if (!text || streaming) return;
    onSend(text);
    setValue("");
  }
  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  }

  return (
    <div className="shrink-0 bg-bg px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2 md:px-6 md:pb-5">
      <div className="mx-auto flex w-full max-w-3xl items-end gap-1.5 rounded-3xl border border-border bg-subtle p-1.5 transition-colors focus-within:border-border-strong">
        <textarea
          ref={ref}
          rows={1}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          autoFocus={autoFocus}
          maxLength={16000}
          placeholder={t("chat.placeholder", { name })}
          aria-label={t("chat.message")}
          dir="auto"
          className="max-h-[200px] min-h-[36px] flex-1 resize-none bg-transparent px-3 py-[7px] text-[15px] leading-[22px] placeholder:text-fg-subtle focus:outline-none"
        />
        {streaming ? (
          <button type="button" onClick={onStop} aria-label={t("chat.stop")} className="pressable grid h-9 w-9 shrink-0 place-items-center rounded-full bg-fg text-bg">
            <Square className="h-3.5 w-3.5 fill-current" />
          </button>
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={!value.trim()}
            aria-label={t("chat.send")}
            className="pressable grid h-9 w-9 shrink-0 place-items-center rounded-full bg-fg text-bg disabled:bg-muted disabled:text-fg-subtle"
          >
            <ArrowUp className="h-[18px] w-[18px]" strokeWidth={2.2} />
          </button>
        )}
      </div>
    </div>
  );
}
