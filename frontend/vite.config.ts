import fs from "node:fs";
import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const appVersion = fs.readFileSync(path.resolve(__dirname, "../VERSION"), "utf8").trim();
if (!/^v\d+\.\d+\.\d+$/.test(appVersion)) {
  throw new Error(`VERSION must use v<major>.<minor>.<patch>, received: ${appVersion}`);
}

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  plugins: [react()],
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
