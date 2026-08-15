import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "@/app/App";
import { MobileServerGate } from "@/app/MobileServerGate";
import { ToastProvider } from "@/components/ui/toast";
import { PWAServiceWorker } from "@/app/PWAServiceWorker";
import { initializeStoredTheme } from "@/app/theme";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import "./styles.css";

initializeStoredTheme();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <LocaleProvider>
      <ToastProvider>
        <MobileServerGate>
          <PWAServiceWorker />
          <App />
        </MobileServerGate>
      </ToastProvider>
    </LocaleProvider>
  </React.StrictMode>,
);
