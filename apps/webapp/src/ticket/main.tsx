import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { wireContentInsets } from "../telegram-insets.js";
import "./ticket.css";

const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();
// Open as a true full-screen web app (Bot API 8.0) so there's no Mini App
// header bar — the ticket is a branded, immersive moment. Falls back to a
// plain expanded view on older clients that don't support requestFullscreen.
if (tg?.isVersionAtLeast?.("8.0")) {
  try {
    tg.requestFullscreen?.();
  } catch {
    // Older/unsupported client — expand() above already maximised height.
  }
}
// Fullscreen floats Telegram's close × / menu ⋯ over the page; reserve room
// for them so the header doesn't slide under the chrome (--tg-content-top).
wireContentInsets(tg);
// Lock the chrome to the dark premium theme regardless of the user's Telegram
// theme — the ticket is a branded moment, not a themed form.
tg?.setHeaderColor?.("#120E1C");
tg?.setBackgroundColor?.("#120E1C");
tg?.setBottomBarColor?.("#120E1C");

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
