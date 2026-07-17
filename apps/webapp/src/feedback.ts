/**
 * Post-date feedback Mini App entry point.
 *
 * Triggered from the bot's post-date DM (`apps/bot/src/services/date-lifecycle.ts`)
 * via an inline `web_app` button → `WEBAPP_FEEDBACK_URL?match={id}&lang={en|ru|uk|de|pl}`.
 *
 * Submission flow:
 *   1. User adjusts the chemistry slider (1–10), picks Yes/Maybe/No, optionally
 *      types a free-text note.
 *   2. Native MainButton ("Send") becomes active once at least one signal has
 *      been touched (a default chemistry of 5 isn't sent until the user
 *      explicitly engages — they shouldn't ship a "5/10 maybe" by accident).
 *   3. On confirm we POST `{ matchId, chemistry, wantsSecondDate, text, language }`
 *      to `/v1/feedback/post-date`. Auth: `Authorization: tma <initData>`.
 *   4. The bot replies to the chat with `feedbackThanks`; we close the app.
 *
 * Draft persistence: the slider value, second-date pick, and text are
 * cached to DeviceStorage on every change so a swipe-down dismissal doesn't
 * wipe what the user typed (mirrors the calendar pattern).
 */

import { wireContentInsets } from "./telegram-insets.js";

const app = window.Telegram?.WebApp;
app?.ready();
app?.expand();

// Full-screen immersive web app (Bot API 8.0+). Older clients fall back to
// expand(). Paint Telegram's chrome to match the active theme so the header /
// background / bottom bar never flash the wrong color around the glass.
const bootTheme = document.documentElement.dataset.theme === "light" ? "light" : "dark";
const chromeColor = bootTheme === "light" ? "#f5f5f5" : "#030303";
try {
  if (app?.isVersionAtLeast?.("8.0") && !app.isFullscreen) app.requestFullscreen?.();
  app?.setHeaderColor?.(chromeColor);
  app?.setBackgroundColor?.(chromeColor);
  app?.setBottomBarColor?.(chromeColor);
} catch {
  // Best-effort cosmetic boot — never crash over chrome theming.
}
// Reserve room for Telegram's floating close × / menu ⋯ in fullscreen mode.
wireContentInsets(app);
// Retire the native MainButton — submit is an in-page glass button.
app?.MainButton?.hide?.();

const params = new URLSearchParams(location.search);
const matchId = app?.initDataUnsafe?.start_param ?? params.get("match") ?? "";
const queryLang = params.get("lang") ?? app?.initDataUnsafe?.user?.language_code ?? "";

type Lang = "en" | "ru" | "uk" | "de" | "pl";
const SUPPORTED_LANGS: ReadonlySet<Lang> = new Set(["en", "ru", "uk", "de", "pl"]);
const lang: Lang = SUPPORTED_LANGS.has(queryLang as Lang) ? (queryLang as Lang) : "en";
document.documentElement?.setAttribute("lang", lang);

type SecondDate = "yes" | "maybe" | "no";

interface I18nStrings {
  heroTitle: string;
  heroSub: string;
  cardChemistry: string;
  cardSecondDate: string;
  cardNotes: string;
  endLow: string;
  endHigh: string;
  sdYes: string;
  sdMaybe: string;
  sdNo: string;
  notesPlaceholders: string[];
  footerNote: string;
  fallbackNoMatch: string;
  mainBtnIdle: string;
  mainBtnSending: string;
  alertExpired: string;
  alertNotFound: string;
  alertWrongState: string;
  alertNotParticipant: string;
  alertGeneric: string;
  alertNetwork: string;
}

const T: Record<Lang, I18nStrings> = {
  en: {
    heroTitle: "How was your date?",
    heroSub: "A few quick taps. The more honest, the better the next match.",
    cardChemistry: "Chemistry",
    cardSecondDate: "Second date?",
    cardNotes: "Anything else?",
    endLow: "🧊 cold",
    endHigh: "⚡ chemistry",
    sdYes: "Yes",
    sdMaybe: "Maybe",
    sdNo: "No",
    notesPlaceholders: [
      "What stood out — good or bad?",
      "Anything that surprised you?",
      "A red flag, a green flag — anything?",
      "Would you change anything about the setup?",
    ],
    footerNote: "Stays between you and Gennety. Used to tune your future matches.",
    fallbackNoMatch: "Open this from the post-date message in the bot.",
    mainBtnIdle: "Send",
    mainBtnSending: "Sending…",
    alertExpired: "This form expired. Reopen it from the bot.",
    alertNotFound: "Couldn't find this match anymore. Reopen the form from the bot.",
    alertWrongState: "This match isn't waiting for feedback yet.",
    alertNotParticipant: "You're not part of this match.",
    alertGeneric: "Couldn't send your feedback. Try again.",
    alertNetwork: "Network error. Check your connection and try again.",
  },
  ru: {
    heroTitle: "Как прошло свидание?",
    heroSub: "Пара тапов — и мы найдём кого-то ещё точнее в следующий раз.",
    cardChemistry: "Химия",
    cardSecondDate: "Готов(а) на вторую встречу?",
    cardNotes: "Что-то ещё?",
    endLow: "🧊 холодно",
    endHigh: "⚡ искра",
    sdYes: "Да",
    sdMaybe: "Может быть",
    sdNo: "Нет",
    notesPlaceholders: [
      "Что зацепило — в хорошем или плохом?",
      "Что удивило?",
      "Красные флаги, зелёные флаги — что угодно",
      "Что бы изменил(а) в формате?",
    ],
    footerNote: "Останется между тобой и Gennety. Используем для будущих мэтчей.",
    fallbackNoMatch: "Открой эту форму из сообщения бота про свидание.",
    mainBtnIdle: "Отправить",
    mainBtnSending: "Отправляю…",
    alertExpired: "Форма устарела. Открой её снова из чата с ботом.",
    alertNotFound: "Не нашли этот мэтч. Открой форму заново.",
    alertWrongState: "Этот мэтч пока не ждёт фидбэка.",
    alertNotParticipant: "Ты не участник этого мэтча.",
    alertGeneric: "Не получилось отправить. Попробуй ещё раз.",
    alertNetwork: "Сеть барахлит. Проверь подключение и попробуй снова.",
  },
  uk: {
    heroTitle: "Як пройшло побачення?",
    heroSub: "Пара тапів — і ми знайдемо когось ще точніше наступного разу.",
    cardChemistry: "Хімія",
    cardSecondDate: "Готовий(а) на другу зустріч?",
    cardNotes: "Щось іще?",
    endLow: "🧊 холодно",
    endHigh: "⚡ іскра",
    sdYes: "Так",
    sdMaybe: "Можливо",
    sdNo: "Ні",
    notesPlaceholders: [
      "Що зачепило — у хорошому чи поганому?",
      "Що здивувало?",
      "Червоні прапорці, зелені прапорці — що завгодно",
      "Що б змінив(ла) у форматі?",
    ],
    footerNote: "Залишиться між тобою та Gennety. Використаємо для майбутніх метчів.",
    fallbackNoMatch: "Відкрий цю форму з повідомлення бота про побачення.",
    mainBtnIdle: "Надіслати",
    mainBtnSending: "Надсилаю…",
    alertExpired: "Форма застаріла. Відкрий її знову з чату з ботом.",
    alertNotFound: "Не знайшли цей метч. Відкрий форму заново.",
    alertWrongState: "Цей метч поки не чекає на фідбек.",
    alertNotParticipant: "Ти не учасник цього метчу.",
    alertGeneric: "Не вийшло надіслати. Спробуй ще раз.",
    alertNetwork: "Мережа барахлить. Перевір з'єднання і спробуй ще раз.",
  },
  de: {
    heroTitle: "Wie war dein Date?",
    heroSub: "Ein paar schnelle Taps. Je ehrlicher, desto besser das nächste Match.",
    cardChemistry: "Chemie",
    cardSecondDate: "Zweites Date?",
    cardNotes: "Sonst noch etwas?",
    endLow: "kühl",
    endHigh: "Chemie",
    sdYes: "Ja",
    sdMaybe: "Vielleicht",
    sdNo: "Nein",
    notesPlaceholders: [
      "Was ist dir aufgefallen - gut oder schlecht?",
      "Hat dich etwas überrascht?",
      "Red Flag, Green Flag - irgendwas?",
      "Würdest du am Setup etwas ändern?",
    ],
    footerNote: "Bleibt zwischen dir und Gennety. Wir nutzen es für bessere zukünftige Matches.",
    fallbackNoMatch: "Öffne dieses Formular aus der Nachricht nach dem Date im Bot.",
    mainBtnIdle: "Senden",
    mainBtnSending: "Senden...",
    alertExpired: "Dieses Formular ist abgelaufen. Öffne es bitte erneut aus dem Bot.",
    alertNotFound: "Wir finden dieses Match nicht mehr. Öffne das Formular bitte erneut.",
    alertWrongState: "Dieses Match wartet noch nicht auf Feedback.",
    alertNotParticipant: "Du bist nicht Teil dieses Matches.",
    alertGeneric: "Feedback konnte nicht gesendet werden. Versuch es erneut.",
    alertNetwork: "Netzwerkfehler. Prüfe deine Verbindung und versuch es erneut.",
  },
  pl: {
    heroTitle: "Jak minęła randka?",
    heroSub: "Kilka szybkich kliknięć. Im szczerzej, tym lepsze kolejne dopasowanie.",
    cardChemistry: "Chemia",
    cardSecondDate: "Druga randka?",
    cardNotes: "Coś jeszcze?",
    endLow: "chłodno",
    endHigh: "chemia",
    sdYes: "Tak",
    sdMaybe: "Może",
    sdNo: "Nie",
    notesPlaceholders: [
      "Co się wyróżniło - dobrego albo złego?",
      "Czy coś Cię zaskoczyło?",
      "Czerwona flaga, zielona flaga - cokolwiek?",
      "Czy zmienił(a)byś coś w organizacji?",
    ],
    footerNote: "Zostaje między Tobą a Gennety. Użyjemy tego do lepszych przyszłych dopasowań.",
    fallbackNoMatch: "Otwórz ten formularz z wiadomości po randce w bocie.",
    mainBtnIdle: "Wyślij",
    mainBtnSending: "Wysyłanie...",
    alertExpired: "Ten formularz wygasł. Otwórz go ponownie z bota.",
    alertNotFound: "Nie możemy już znaleźć tego dopasowania. Otwórz formularz ponownie.",
    alertWrongState: "To dopasowanie nie czeka jeszcze na feedback.",
    alertNotParticipant: "Nie jesteś częścią tego dopasowania.",
    alertGeneric: "Nie udało się wysłać feedbacku. Spróbuj ponownie.",
    alertNetwork: "Błąd sieci. Sprawdź połączenie i spróbuj ponownie.",
  },
};
const strings = T[lang];

const NS = "gennety.feedback";
function draftKey(id: string): string {
  return `${NS}.match.${id}`;
}

interface DraftState {
  chemistry: number;
  wantsSecondDate: SecondDate | null;
  text: string;
  /** True iff the user has touched chemistry or second-date (text alone doesn't count). */
  touched: boolean;
}

function defaultDraft(): DraftState {
  return { chemistry: 5, wantsSecondDate: null, text: "", touched: false };
}

async function loadDraft(id: string): Promise<DraftState> {
  const raw = await readKey(draftKey(id));
  if (!raw) return defaultDraft();
  try {
    const parsed = JSON.parse(raw) as Partial<DraftState>;
    return {
      chemistry: clampInt(parsed.chemistry ?? 5, 1, 10),
      wantsSecondDate: isSecondDate(parsed.wantsSecondDate) ? parsed.wantsSecondDate : null,
      text: typeof parsed.text === "string" ? parsed.text : "",
      touched: parsed.touched === true,
    };
  } catch {
    return defaultDraft();
  }
}

function saveDraft(id: string, draft: DraftState): void {
  void writeKey(draftKey(id), JSON.stringify(draft));
}
function clearDraft(id: string): void {
  void removeKey(draftKey(id));
}

function isSecondDate(v: unknown): v is SecondDate {
  return v === "yes" || v === "maybe" || v === "no";
}

function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.round(n)));
}

// ── DeviceStorage helpers (same fallback-to-localStorage pattern as the calendar)

function deviceStorage(): TelegramWebAppDeviceStorage | null {
  return window.Telegram?.WebApp?.DeviceStorage ?? null;
}
function readKey(key: string): Promise<string | null> {
  const ds = deviceStorage();
  if (!ds) {
    try {
      return Promise.resolve(window.localStorage.getItem(key));
    } catch {
      return Promise.resolve(null);
    }
  }
  return new Promise((resolve) => {
    ds.getItem(key, (err, value) => {
      if (err) console.warn("DeviceStorage getItem failed:", err);
      resolve(value ?? null);
    });
  });
}
function writeKey(key: string, value: string): Promise<void> {
  const ds = deviceStorage();
  if (!ds) {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // ignore
    }
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    ds.setItem(key, value, (err) => {
      if (err) console.warn("DeviceStorage setItem failed:", err);
      resolve();
    });
  });
}
function removeKey(key: string): Promise<void> {
  const ds = deviceStorage();
  if (!ds) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // ignore
    }
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    ds.removeItem(key, () => resolve());
  });
}

// ── API ──

const apiBase = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "");

interface PostBody {
  matchId: string;
  chemistry: number;
  wantsSecondDate: SecondDate;
  text: string;
  language: Lang;
}
interface PostError {
  status: number;
  reason?: string;
}

async function submitFeedback(initData: string, body: PostBody): Promise<PostError | null> {
  let res: Response;
  try {
    res = await fetch(`${apiBase}/v1/feedback/post-date`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `tma ${initData}`,
      },
      body: JSON.stringify(body),
    });
  } catch {
    return { status: 0 };
  }
  if (res.ok) return null;
  let reason: string | undefined;
  try {
    const j = (await res.json()) as { error?: string; reason?: string };
    reason = j.reason ?? j.error;
  } catch {
    // empty body
  }
  return { status: res.status, ...(reason ? { reason } : {}) };
}

function alertFor(err: PostError): string {
  if (err.status === 0) return strings.alertNetwork;
  switch (err.reason) {
    case "expired":
    case "missing-hash":
    case "bad-hash":
    case "missing-auth-date":
      return strings.alertExpired;
    case "match-not-found":
    case "user-not-found":
      return strings.alertNotFound;
    case "wrong-state":
      return strings.alertWrongState;
    case "not-participant":
      return strings.alertNotParticipant;
    default:
      return strings.alertGeneric;
  }
}

// ── Boot ──

void main();

async function main(): Promise<void> {
  const page = document.getElementById("page");
  const fallback = document.getElementById("fallback");
  if (!matchId || !page || !fallback) {
    if (fallback) {
      const msg = fallback.querySelector<HTMLElement>("#fallback-msg");
      if (msg) msg.textContent = strings.fallbackNoMatch;
      fallback.hidden = false;
    }
    return;
  }
  page.hidden = false;

  // Static i18n bindings.
  const $title = document.getElementById("hero-title")!;
  $title.textContent = strings.heroTitle;
  document.getElementById("hero-sub")!.textContent = strings.heroSub;
  document.getElementById("chem-label")!.textContent = strings.cardChemistry;
  document.getElementById("sd-label")!.textContent = strings.cardSecondDate;
  document.getElementById("notes-label")!.textContent = strings.cardNotes;
  document.getElementById("slider-end-low")!.textContent = strings.endLow;
  document.getElementById("slider-end-high")!.textContent = strings.endHigh;
  document.getElementById("sd-yes")!.textContent = strings.sdYes;
  document.getElementById("sd-maybe")!.textContent = strings.sdMaybe;
  document.getElementById("sd-no")!.textContent = strings.sdNo;
  document.getElementById("footer-note")!.textContent = strings.footerNote;
  document.title = strings.heroTitle;

  const draft = await loadDraft(matchId);
  const state: DraftState = draft;
  let submitting = false;

  const $track = document.getElementById("slider-track") as HTMLDivElement;
  const $fill = document.getElementById("slider-fill") as HTMLDivElement;
  const $thumb = document.getElementById("slider-thumb") as HTMLButtonElement;
  const $value = document.getElementById("slider-value") as HTMLSpanElement;
  const $segmented = document.getElementById("sd-segmented") as HTMLDivElement;
  const $notes = document.getElementById("notes") as HTMLTextAreaElement;
  const $hint = document.getElementById("notes-hint") as HTMLSpanElement;
  const $counter = document.getElementById("notes-counter") as HTMLSpanElement;

  const segmentBtns = $segmented.querySelectorAll<HTMLButtonElement>(".segment");

  function persist(): void {
    saveDraft(matchId, state);
  }

  function renderSlider(): void {
    const pct = ((state.chemistry - 1) / 9) * 100;
    $fill.style.width = `${pct}%`;
    $thumb.style.left = `calc(${pct}% )`;
    $thumb.setAttribute("aria-valuenow", String(state.chemistry));
    $value.textContent = String(state.chemistry);
  }

  function renderSegmented(): void {
    let idx = -1;
    segmentBtns.forEach((btn, i) => {
      const on = btn.dataset.value === state.wantsSecondDate;
      btn.setAttribute("aria-selected", on ? "true" : "false");
      if (on) idx = i;
    });
    // Drive the sliding indicator; hide it until a real choice is made.
    if (idx >= 0) {
      $segmented.style.setProperty("--seg-index", String(idx));
      $segmented.classList.add("is-selected");
    } else {
      $segmented.classList.remove("is-selected");
    }
  }

  function renderCounter(): void {
    const len = state.text.length;
    $counter.textContent = `${len} / 600`;
    $counter.classList.toggle("is-near-cap", len > 540);
  }

  const $submitBar = document.getElementById("submit-bar") as HTMLDivElement;
  const $submitBtn = document.getElementById("submit-btn") as HTMLButtonElement;

  function syncSubmit(): void {
    // Enabled once the user has actually engaged (a default 5/10 isn't shippable
    // by accident); locked while a send is in flight.
    $submitBtn.disabled = !state.touched || submitting;
  }

  // ── Slider interaction (custom — native range input doesn't theme well)

  function setChemistryFromX(clientX: number): void {
    const rect = $track.getBoundingClientRect();
    const ratio = (clientX - rect.left) / rect.width;
    const next = clampInt(1 + ratio * 9, 1, 10);
    if (next !== state.chemistry) {
      state.chemistry = next;
      state.touched = true;
      renderSlider();
      persist();
      syncSubmit();
      window.Telegram?.WebApp?.HapticFeedback?.selectionChanged();
    }
  }

  let pointerId: number | null = null;
  function onPointerDown(e: PointerEvent): void {
    pointerId = e.pointerId;
    $thumb.classList.add("is-dragging");
    $track.setPointerCapture(e.pointerId);
    setChemistryFromX(e.clientX);
  }
  function onPointerMove(e: PointerEvent): void {
    if (pointerId !== e.pointerId) return;
    setChemistryFromX(e.clientX);
  }
  function onPointerUp(e: PointerEvent): void {
    if (pointerId !== e.pointerId) return;
    pointerId = null;
    $thumb.classList.remove("is-dragging");
    try {
      $track.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  }
  $track.addEventListener("pointerdown", onPointerDown);
  $track.addEventListener("pointermove", onPointerMove);
  $track.addEventListener("pointerup", onPointerUp);
  $track.addEventListener("pointercancel", onPointerUp);

  // Keyboard a11y on the thumb.
  $thumb.addEventListener("keydown", (e) => {
    let next = state.chemistry;
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") next -= 1;
    else if (e.key === "ArrowRight" || e.key === "ArrowUp") next += 1;
    else if (e.key === "Home") next = 1;
    else if (e.key === "End") next = 10;
    else return;
    e.preventDefault();
    next = clampInt(next, 1, 10);
    if (next !== state.chemistry) {
      state.chemistry = next;
      state.touched = true;
      renderSlider();
      persist();
      syncSubmit();
      window.Telegram?.WebApp?.HapticFeedback?.selectionChanged();
    }
  });

  // ── Segmented control

  for (const btn of segmentBtns) {
    btn.addEventListener("click", () => {
      const value = btn.dataset.value;
      if (!isSecondDate(value)) return;
      state.wantsSecondDate = value;
      state.touched = true;
      renderSegmented();
      persist();
      syncSubmit();
      window.Telegram?.WebApp?.HapticFeedback?.impactOccurred("light");
    });
  }

  // ── Textarea + cycling placeholder

  $notes.value = state.text;
  let placeholderIdx = Math.floor(Math.random() * strings.notesPlaceholders.length);
  function rotatePlaceholder(): void {
    $notes.placeholder = strings.notesPlaceholders[placeholderIdx]!;
    $hint.textContent = "";
    placeholderIdx = (placeholderIdx + 1) % strings.notesPlaceholders.length;
  }
  rotatePlaceholder();
  // Rotate the placeholder every 4s while the textarea is empty + unfocused.
  const placeholderTimer = window.setInterval(() => {
    if (document.activeElement !== $notes && !state.text) rotatePlaceholder();
  }, 4000);

  $notes.addEventListener("input", () => {
    state.text = $notes.value;
    persist();
    renderCounter();
  });

  // ── MainButton wiring

  // Wire the in-page glass submit button (native MainButton stays retired).
  $submitBtn.textContent = strings.mainBtnIdle;
  $submitBtn.addEventListener("click", () => void handleSubmit());
  $submitBar.hidden = false;

  // Initial paint.
  renderSlider();
  renderSegmented();
  renderCounter();
  syncSubmit();

  async function handleSubmit(): Promise<void> {
    if (!app || submitting || !state.touched) return;
    if (!state.wantsSecondDate) {
      // We require the second-date pick before sending — chemistry alone is too
      // ambiguous a signal for the matching adjustment. Nudge the user and
      // pulse the segmented control.
      app.HapticFeedback?.notificationOccurred("warning");
      $segmented.animate(
        [
          { transform: "translateX(0)" },
          { transform: "translateX(-4px)" },
          { transform: "translateX(4px)" },
          { transform: "translateX(0)" },
        ],
        { duration: 240, easing: "ease-out" },
      );
      return;
    }

    submitting = true;
    $submitBtn.textContent = strings.mainBtnSending;
    $submitBtn.classList.add("is-sending");
    $submitBtn.disabled = true;

    const err = await submitFeedback(app.initData, {
      matchId,
      chemistry: state.chemistry,
      wantsSecondDate: state.wantsSecondDate,
      text: state.text,
      language: lang,
    });

    if (err) {
      submitting = false;
      $submitBtn.classList.remove("is-sending");
      $submitBtn.textContent = strings.mainBtnIdle;
      syncSubmit();
      app.HapticFeedback?.notificationOccurred("error");
      app.showAlert(alertFor(err));
      return;
    }

    window.clearInterval(placeholderTimer);
    clearDraft(matchId);
    app.HapticFeedback?.notificationOccurred("success");
    app.close();
  }
}
