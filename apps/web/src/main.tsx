import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, RouterProvider } from "react-router";
import "./styles/index.css";
import { initTheme } from "./lib/theme";
import { initLocale, LocaleProvider } from "./lib/i18n";
import { initPwa, onServiceWorkerMessage } from "./lib/pwa";
import { initNativeNavigation } from "./lib/native";
import { App } from "./App";
import { SessionProvider } from "./hooks/session";
import { ToastProvider } from "./hooks/toast";
import { ApiError } from "./lib/api";

initTheme();
initLocale();
initPwa();
initNativeNavigation();

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

// A data router (not <BrowserRouter>) so navigations can run as View Transitions; the app keeps
// its own <Routes> tree inside the single root route.
const router = createBrowserRouter([
  {
    path: "*",
    element: (
      <LocaleProvider>
        <ToastProvider>
          <SessionProvider>
            <App />
          </SessionProvider>
        </ToastProvider>
      </LocaleProvider>
    ),
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
