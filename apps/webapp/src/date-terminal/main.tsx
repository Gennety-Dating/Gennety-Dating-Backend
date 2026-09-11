import { createRoot } from "react-dom/client";
import { DateTerminal } from "./App.js";
import { wireContentInsets } from "../telegram-insets.js";
import "../ticket/ticket.css";
import "./terminal.css";

const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();
// Full screen like the ticket (Bot API 8.0): the terminal is an immersive
// moment at the table, and Telegram's header bar would sit on the glass.
if (tg?.isVersionAtLeast?.("8.0")) {
  try {
    tg.requestFullscreen?.();
  } catch {
    // Older client — expand() above already maximised the height.
  }
}
// A screen you SHAKE: without these, the shake itself rotates the WebView or
// drags the sheet down and closes it mid-sync.
tg?.lockOrientation?.();
tg?.disableVerticalSwipes?.();
wireContentInsets(tg);
// Dark glass in both themes (see date-terminal.html), so the chrome is dark too.
document.documentElement.dataset.theme = "dark";
tg?.setHeaderColor?.("#030303");
tg?.setBackgroundColor?.("#030303");
tg?.setBottomBarColor?.("#030303");

const root = document.getElementById("root");
if (root) createRoot(root).render(<DateTerminal />);
