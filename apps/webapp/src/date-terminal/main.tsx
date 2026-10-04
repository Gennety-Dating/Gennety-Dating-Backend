import { createRoot } from "react-dom/client";
import { DateTerminal } from "./App.js";
import { wireContentInsets } from "../telegram-insets.js";
import { keepOpenOnVerticalSwipe } from "../telegram-swipes.js";
import "../ticket/ticket.css";
import "./terminal.css";

const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();
keepOpenOnVerticalSwipe(tg);
// Full screen like the ticket (Bot API 8.0): the terminal is an immersive
// moment at the table, and Telegram's header bar would sit on the glass.
if (tg?.isVersionAtLeast?.("8.0")) {
  try {
    tg.requestFullscreen?.();
  } catch {
    // Older client — expand() above already maximised the height.
  }
}
// A screen laid flat on a table (the hold, then the meeting ceremony, which is
// planned on this viewport): without the lock a phone put down rotates the
// WebView mid-scene (swipe-to-close is already off above).
tg?.lockOrientation?.();
wireContentInsets(tg);
// Dark glass in both themes (see date-terminal.html), so the chrome is dark too.
document.documentElement.dataset.theme = "dark";
tg?.setHeaderColor?.("#030303");
tg?.setBackgroundColor?.("#030303");
tg?.setBottomBarColor?.("#030303");

const root = document.getElementById("root");
if (root) createRoot(root).render(<DateTerminal />);
