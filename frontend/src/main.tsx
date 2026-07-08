import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "@/app/App";
import { ToastProvider } from "@/components/ui/toast";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ToastProvider>
      <App />
    </ToastProvider>
  </React.StrictMode>,
);
