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
// Paint Telegram's chrome to match the active app theme (set pre-paint by the
// boot snippet).
const chromeColor =
  document.documentElement.dataset.theme === "light" ? "#f5f5f5" : "#030303";
tg?.setHeaderColor?.(chromeColor);
tg?.setBackgroundColor?.(chromeColor);
tg?.setBottomBarColor?.(chromeColor);

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
