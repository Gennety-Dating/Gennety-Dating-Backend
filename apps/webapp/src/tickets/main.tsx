import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "../ticket/ticket.css";
import "./store.css";

const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();
if (tg?.isVersionAtLeast?.("8.0")) {
  try {
    tg.requestFullscreen?.();
  } catch {
    // Older client — expand() already maximised height.
  }
}
// Lock the chrome to the dark premium theme (matches the Date Ticket Mini App).
tg?.setHeaderColor?.("#120E1C");
tg?.setBackgroundColor?.("#120E1C");
tg?.setBottomBarColor?.("#120E1C");

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
