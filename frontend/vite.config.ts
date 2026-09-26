import fs from "node:fs";
import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

import { serviceWorkerBuildId, stampServiceWorker } from "./src/pwa/serviceWorkerBuild";

const appVersion = fs.readFileSync(path.resolve(__dirname, "../VERSION"), "utf8").trim();
if (!/^v\d+\.\d+\.\d+$/.test(appVersion)) {
  throw new Error(`VERSION must use v<major>.<minor>.<patch>, received: ${appVersion}`);
}

// Stamps the copied public/sw.js with an id derived from this build's output,
// giving each build its own service worker cache.
function serviceWorkerBuildPlugin(): Plugin {
  let buildId = "";
  return {
    name: "kikoto:service-worker-build",
    apply: "build",
    generateBundle(_options, bundle) {
      buildId = serviceWorkerBuildId(appVersion, Object.keys(bundle));
    },
    writeBundle(options) {
      const worker = path.join(options.dir!, "sw.js");
      fs.writeFileSync(worker, stampServiceWorker(fs.readFileSync(worker, "utf8"), buildId));
    },
  };
}

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  plugins: [react(), serviceWorkerBuildPlugin()],
  build: {
    rollupOptions: {
      output: {
        // Framework libraries change far less often than app code, so a
        // separate chunk stays in the browser cache across releases. Only list
        // libraries the entry already loads; anything listed here loads eagerly.
        manualChunks: {
          vendor: [
            "react",
            "react/jsx-runtime",
            "react-dom",
            "react-dom/client",
            "i18next",
            "react-i18next",
            "tailwind-merge",
          ],
        },
      },
    },
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:7659",
      "/health": "http://127.0.0.1:7659",
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
