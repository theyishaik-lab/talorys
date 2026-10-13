import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router";
import "./styles/index.css";
import { initTheme } from "./lib/theme";
import { initLocale, LocaleProvider } from "./lib/i18n";
import { initPwa, onServiceWorkerMessage } from "./lib/pwa";
import { App } from "./App";
import { SessionProvider } from "./hooks/session";
import { ToastProvider } from "./hooks/toast";
import { ApiError } from "./lib/api";

initTheme();
initLocale();
initPwa();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: true,
      retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
    },
  },
});

// A push that arrived while the app is open: refresh the bell and the chat it points at.
onServiceWorkerMessage((m) => {
  void queryClient.invalidateQueries({ queryKey: ["notifications"] });
  void queryClient.invalidateQueries({ queryKey: ["conversations"] });
  const conversation = m.payload.url?.match(/^\/chat\/([^/?#]+)/)?.[1];
  if (conversation) void queryClient.invalidateQueries({ queryKey: ["conversation", conversation] });
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <LocaleProvider>
          <ToastProvider>
            <SessionProvider>
              <App />
            </SessionProvider>
          </ToastProvider>
        </LocaleProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
