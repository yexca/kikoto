import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "@/app/App";
import { MobileServerGate } from "@/app/MobileServerGate";
import { ToastProvider } from "@/components/ui/toast";
import { PWAServiceWorker } from "@/app/PWAServiceWorker";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ToastProvider>
      <MobileServerGate>
        <PWAServiceWorker />
        <App />
      </MobileServerGate>
    </ToastProvider>
  </React.StrictMode>,
);
