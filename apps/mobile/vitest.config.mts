import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const stub = (name: string) => fileURLToPath(new URL(`./tests/stubs/${name}.ts`, import.meta.url));

/** Unit tests of the pure logic (SSE parsing, the streaming reducer, i18n). Native modules are stubbed. */
export default defineConfig({
  test: { include: ["tests/**/*.test.ts"], environment: "node" },
  resolve: {
    alias: {
      "@talorys/shared": fileURLToPath(new URL("../../packages/shared/src/index.ts", import.meta.url)),
      "expo/fetch": stub("expo-fetch"),
      "expo-constants": stub("expo-constants"),
      "expo-secure-store": stub("expo-secure-store"),
      "expo-localization": stub("expo-localization"),
      "@react-native-async-storage/async-storage": stub("async-storage"),
      "react-native": stub("react-native"),
    },
  },
});
