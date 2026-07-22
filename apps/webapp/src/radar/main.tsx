import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { wireContentInsets } from "../telegram-insets.js";
import "./radar.css";

const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();
if (tg?.isVersionAtLeast?.("8.0")) {
  try {
    tg.requestFullscreen?.();
  } catch {
    // Older/unsupported client — expand() already maximised height.
  }
}
wireContentInsets(tg);

// Paint Telegram's chrome to match the active app theme (set pre-paint by the
// boot snippet in radar.html) so it doesn't flash the wrong color.
const chromeColor =
  document.documentElement.dataset.theme === "light" ? "#f5f5f5" : "#030303";
tg?.setHeaderColor?.(chromeColor);
tg?.setBackgroundColor?.(chromeColor);
tg?.setBottomBarColor?.(chromeColor);

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
