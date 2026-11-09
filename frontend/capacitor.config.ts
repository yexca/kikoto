import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.yexca.kikoto",
  appName: "Kikoto",
  webDir: "dist",
  server: {
    androidScheme: "http",
    cleartext: true,
  },
  plugins: {
    // The Android shell's KikotoSystemInsets owns the system bar insets.
    SystemBars: {
      insetsHandling: "disable",
    },
  },
};

export default config;
