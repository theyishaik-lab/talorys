import { Component, type ReactNode, useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";

/**
 * The screen that replaces a black screen. A release build has no red box: a JS error during the
 * first render used to leave the window background and nothing else. This boundary catches render
 * errors, and the global handler below catches everything thrown outside React (promises, timers,
 * native-module calls) and shows it in the same plain, dependency-free screen — plain components on
 * purpose, so it renders even when fonts, theme or i18n are what broke.
 */
interface State {
  error: Error | null;
}

let lastGlobalError: Error | null = null;
const listeners = new Set<(e: Error) => void>();

type GlobalHandler = (error: unknown, isFatal?: boolean) => void;
const errorUtils = (globalThis as { ErrorUtils?: { getGlobalHandler(): GlobalHandler; setGlobalHandler(h: GlobalHandler): void } }).ErrorUtils;
const previous = errorUtils?.getGlobalHandler();
errorUtils?.setGlobalHandler((error, isFatal) => {
  const e = error instanceof Error ? error : new Error(String(error));
  lastGlobalError = e;
  for (const fn of listeners) fn(e);
  // Not fatal from here on: the screen below shows it instead of the process dying.
  if (!isFatal) previous?.(error, isFatal);
});

export function describeError(e: Error): string {
  const stack = (e.stack ?? "").split("\n").slice(0, 12).join("\n");
  return `${e.name}: ${e.message}\n\n${stack}`;
}

export function ErrorScreen({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  return (
    <View style={{ flex: 1, backgroundColor: "#FFFFFF", paddingTop: 56, paddingHorizontal: 20 }}>
      <Text style={{ fontSize: 20, fontWeight: "600", color: "#111111", marginBottom: 8 }}>Talorys hit an error</Text>
      <Text style={{ fontSize: 14, color: "#444444", marginBottom: 12 }}>משהו נשבר בפתיחה. זה הטקסט של השגיאה — שלח אותו ל-Tab.</Text>
      <ScrollView style={{ flex: 1, backgroundColor: "#F3F3F5", borderRadius: 12, padding: 12 }}>
        <Text selectable style={{ fontFamily: "monospace", fontSize: 12, color: "#B00020" }}>
          {describeError(error)}
        </Text>
      </ScrollView>
      {onRetry ? (
        <Pressable onPress={onRetry} style={{ marginVertical: 20, backgroundColor: "#4C47E0", borderRadius: 12, paddingVertical: 14, alignItems: "center" }}>
          <Text style={{ color: "#FFFFFF", fontSize: 16, fontWeight: "600" }}>Try again · נסה שוב</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };
  static getDerivedStateFromError(error: Error): State {
    return { error };
  }
  componentDidCatch(error: Error) {
    console.error("render error", error);
  }
  render() {
    if (this.state.error) return <ErrorScreen error={this.state.error} onRetry={() => this.setState({ error: null })} />;
    return this.props.children;
  }
}

/** Shows the last uncaught (non-render) error over the app, dismissable. */
export function GlobalErrorOverlay() {
  const [error, setError] = useState<Error | null>(lastGlobalError);
  useEffect(() => {
    listeners.add(setError);
    return () => {
      listeners.delete(setError);
    };
  }, []);
  if (!error) return null;
  return (
    <View style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0 }}>
      <ErrorScreen error={error} onRetry={() => setError(null)} />
    </View>
  );
}
