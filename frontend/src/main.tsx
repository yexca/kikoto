import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "@/app/App";
import { ToastProvider } from "@/components/ui/toast";
import { PWAServiceWorker } from "@/app/PWAServiceWorker";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ToastProvider>
      <PWAServiceWorker />
      <App />
    </ToastProvider>
  </React.StrictMode>,
);
