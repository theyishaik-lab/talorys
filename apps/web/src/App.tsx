import { lazy, Suspense, useEffect, Component, type ReactNode, type ErrorInfo } from "react";
import { Navigate, Route, Routes } from "react-router";
import { useSession } from "./hooks/session";
import { AppShell } from "./components/AppShell";
import { LoginPage } from "./pages/LoginPage";
import { ChatPage } from "./pages/ChatPage";
import { Spinner, ErrorNotice } from "./components/ui";
import { Logo } from "./components/Logo";
import { useT } from "./lib/i18n";

interface ErrorBoundaryState { error: Error | null }
class AppErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };
  static getDerivedStateFromError(error: Error): ErrorBoundaryState { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error("App render error", error, info); }
  render() {
    if (this.state.error) {
      return (
        <div className="flex min-h-full flex-col items-center justify-center gap-6 p-6">
          <Logo className="h-10 w-10" />
          <div className="w-full max-w-sm">
            <ErrorNotice
              error={this.state.error}
              onRetry={() => this.setState({ error: null })}
            />
          </div>
        </div>
      );
    }
    return this.state.error ? null : this.props.children;
  }
}

const loaders = {
  memory: () => import("./pages/MemoryPage"),
  tasks: () => import("./pages/TasksPage"),
  notes: () => import("./pages/NotesPage"),
  automations: () => import("./pages/AutomationsPage"),
  connections: () => import("./pages/ConnectionsPage"),
  settings: () => import("./pages/SettingsPage"),
};
const MemoryPage = lazy(loaders.memory);
const TasksPage = lazy(loaders.tasks);
const NotesPage = lazy(loaders.notes);
const AutomationsPage = lazy(loaders.automations);
const ConnectionsPage = lazy(loaders.connections);
const SettingsPage = lazy(loaders.settings);

/** Fetches the other screens' code once the chat is idle, so tapping a tab is instant (native feel). */
function usePrefetchPages(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const run = () => {
      for (const load of Object.values(loaders)) void load().catch(() => {});
    };
    // Well after the first screen has settled (a slow phone is still busy for a while after login).
    const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
    const id = setTimeout(() => (w.requestIdleCallback ? w.requestIdleCallback(run, { timeout: 8000 }) : run()), 4000);
    return () => clearTimeout(id);
  }, [enabled]);
}

function FullScreen({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-full flex-col items-center justify-center gap-6 p-6">{children}</div>;
}

export function App() {
  const t = useT();
  const { session, loading, error, refresh } = useSession();
  usePrefetchPages(!!session?.authenticated);

  if (loading) {
    return (
      <FullScreen>
        <Logo className="h-10 w-10" />
        <Spinner />
      </FullScreen>
    );
  }
  if (error || !session) {
    return (
      <FullScreen>
        <Logo className="h-10 w-10" />
        <div className="w-full max-w-sm">
          <ErrorNotice error={error ?? new Error(t("app.unreachable"))} onRetry={() => void refresh()} />
        </div>
      </FullScreen>
    );
  }
  if (!session.authenticated) return <LoginPage configured={session.configured} />;

  return (
    <AppErrorBoundary>
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Navigate to="/chat" replace />} />
        <Route path="chat/:conversationId?" element={<ChatPage />} />
        <Route path="memory" element={<Lazy><MemoryPage /></Lazy>} />
        <Route path="tasks" element={<Lazy><TasksPage /></Lazy>} />
        <Route path="notes/:noteId?" element={<Lazy><NotesPage /></Lazy>} />
        <Route path="automations" element={<Lazy><AutomationsPage /></Lazy>} />
        <Route path="connections" element={<Lazy><ConnectionsPage /></Lazy>} />
        <Route path="settings" element={<Lazy><SettingsPage /></Lazy>} />
        <Route path="*" element={<Navigate to="/chat" replace />} />
      </Route>
    </Routes>
    </AppErrorBoundary>
  );
}

function Lazy({ children }: { children: React.ReactNode }) {
  return (
    <Suspense
      fallback={
        <div className="flex justify-center p-16">
          <Spinner />
        </div>
      }
    >
      {children}
    </Suspense>
  );
}
