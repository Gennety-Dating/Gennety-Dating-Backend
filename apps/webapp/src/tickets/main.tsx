import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { wireContentInsets } from "../telegram-insets.js";
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
// Reserve room for Telegram's floating close × / menu ⋯ in fullscreen so the
// store header / bundle badges don't slide under the chrome (--tg-content-top).
wireContentInsets(tg);
// Lock the chrome to the dark premium theme (matches the Date Ticket Mini App).
tg?.setHeaderColor?.("#120E1C");
tg?.setBackgroundColor?.("#120E1C");
tg?.setBottomBarColor?.("#120E1C");

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
