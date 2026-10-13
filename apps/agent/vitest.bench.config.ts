// Model bench (NOT part of `npm test`): runs the real runner, prompt, tools and Workers AI
// provider against the live Workers AI REST API and a live OpenConnector. Costs neurons.
//   BENCH_CF_ACCOUNT=... BENCH_CF_TOKEN=... BENCH_OC_URL=... BENCH_OC_TOKEN=... \
//   BENCH_MODELS=@cf/zai-org/glm-4.7-flash npx vitest run --config vitest.bench.config.ts
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => ({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      remoteBindings: false,
      miniflare: {
        bindings: {
          TALORYS_ENV: "development",
          TALORYS_MOCK_AI: "1",
          TALORYS_DEV_ORIGINS: "",
          OWNER_PASSWORD_HASH: "unused",
          SESSION_SECRET: "bench-session-secret-0123456789abcdefghijklmnop",
          BENCH_CF_ACCOUNT: process.env.BENCH_CF_ACCOUNT ?? "",
          BENCH_CF_TOKEN: process.env.BENCH_CF_TOKEN ?? "",
          BENCH_OC_URL: process.env.BENCH_OC_URL ?? "",
          BENCH_OC_TOKEN: process.env.BENCH_OC_TOKEN ?? "",
          BENCH_MODELS: process.env.BENCH_MODELS ?? "",
          BENCH_PROMPTS: process.env.BENCH_PROMPTS ?? "",
          BENCH_TZ: process.env.BENCH_TZ ?? "Asia/Jerusalem",
        },
      },
    }),
  ],
  test: { include: ["bench/**/*.bench.test.ts"], testTimeout: 600_000 },
}));
