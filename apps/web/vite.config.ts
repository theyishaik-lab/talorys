import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * Writes dist/sw.js from sw/sw.js with the built shell's asset list and a version derived from
 * the build output, so each deploy installs a new worker that precaches exactly this build.
 */
function talorysServiceWorker(): Plugin {
  let outDir = "dist";
  return {
    name: "talorys-service-worker",
    apply: "build",
    configResolved(config) {
      outDir = config.build.outDir;
    },
    closeBundle(error?: unknown) {
      if (error) return; // a failed build writes no worker (an old dist must not get a fresh sw.js)
      const root = outDir;
      const files: string[] = [];
      const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
          const full = join(dir, name);
          if (statSync(full).isDirectory()) walk(full);
          else files.push(`/${relative(root, full).split("\\").join("/")}`);
        }
      };
      walk(root);
      const shell = files.filter((f) => f.startsWith("/assets/") || f.startsWith("/icons/") || f === "/index.html" || f === "/manifest.webmanifest" || f === "/offline.html" || f === "/favicon.svg").sort();
      const hash = createHash("sha256");
      for (const f of shell) hash.update(f).update(readFileSync(join(root, f)));
      const version = hash.digest("hex").slice(0, 12);
      const template = readFileSync(join(__dirname, "sw", "sw.js"), "utf8");
      writeFileSync(join(root, "sw.js"), template.replace("__VERSION__", version).replace("__SHELL__", JSON.stringify(shell)));
      this.info(`sw.js written: version ${version}, ${shell.length} shell files`);
    },
  };
}

// In development, /api is proxied to `wrangler pages dev` (port 8788), which runs the
// real Pages Function and reaches the agent Worker through its service binding.
export default defineConfig({
  plugins: [react(), tailwindcss(), talorysServiceWorker()],
  server: {
    proxy: {
      "/api": { target: "http://127.0.0.1:8788", changeOrigin: false },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    chunkSizeWarningLimit: 800,
  },
});
