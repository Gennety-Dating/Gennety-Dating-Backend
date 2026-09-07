import express, { Router, type Request, type Response } from "express";
import { prisma } from "@gennety/db";
import { normalizeChannel } from "../../admin/utils/growth.js";
import {
  AD_SPEND_ATTRIBUTION_WINDOW_DAYS,
  AD_SPEND_CATEGORIES,
  UNATTRIBUTED_CHANNEL,
  categoryRequiresUnattributed,
  classifyAdSpendChannel,
  isAdSpendCategory,
  isValidCurrency,
  isValidPeriod,
  type AdSpendCategory,
} from "../../admin/utils/ad-spend.js";
import { loadKnownAdSpendChannels } from "../../admin/utils/ad-spend-channels.js";
import {
  parseIsoDay,
  verifyAdSpendLink,
  type AdSpendLinkPayload,
} from "../../services/founder-ad-spend-link.js";

/**
 * The founder's phone-sized ad-spend form — the other half of the Monday
 * reminder (`notifyFounderAdSpendReminder`).
 *
 * **Why this page exists.** The reminder used to link at the dashboard's
 * `/ad-spend`, which is gated by a Bearer `ADMIN_API_KEY` the dashboard keeps
 * in `sessionStorage`. Telegram opens links in a fresh in-app browser, so that
 * session is always empty: tapping the reminder on a phone meant finding and
 * pasting a 32-byte admin key before typing a single number. In practice that
 * turns a 30-second entry into "later", and the CAC half of every metric on
 * the dashboard quietly goes stale. This page removes the login step with the
 * same device the weekly report already uses — an unguessable token in the
 * path, minted by the reminder itself.
 *
 * **Deliberately not a bot dialog.** `docs/product/domains/ad-spend-tracking.md`
 * weighed and rejected a conversational entry flow: the founder bot is
 * send-only (no update handler, no session), so a dialog means a second bot
 * runner plus a state machine plus free-text number/currency parsing. A form
 * behind a tokenized link is the same one-tap ergonomics with none of that.
 *
 * **No JavaScript.** `helmet()`'s default CSP on the public app is
 * `script-src 'self'`, so an inline script would be blocked outright; rather
 * than carve out a nonce for a convenience, the page is a plain HTML form and
 * the server does the one thing JS would have done — suggest the USD
 * equivalent — from the same rate table the dashboard form uses.
 */
export const founderAdSpendRouter: Router = Router();

/**
 * Approximate USD rates, used ONLY to prefill the USD field when it is left
 * blank. Same table and same status as the dashboard form's: a suggestion the
 * founder can always overwrite, never a silent recomputation of a stored
 * figure (`amount_usd_cents` is frozen at entry — see the schema comment).
 */
const APPROX_USD_RATE: Record<string, number> = {
  USD: 1,
  UAH: 0.024,
  EUR: 1.08,
  GBP: 1.26,
  PLN: 0.25,
};

const CATEGORY_LABEL: Record<AdSpendCategory, string> = {
  performance_ads: "Перформанс-реклама",
  influencer: "Блогер",
  offline_event: "Офлайн-мероприятие",
  content_production: "Продакшн контента",
  agency: "Агентство / ретейнер",
  other: "Другое",
};

/**
 * Categories where a bare number is not a usable record six months later —
 * "который блогер?", "какое мероприятие?". Mirrors the dashboard form's own
 * `NOTE_REQUIRED`; both are client-side because the admin route accepts a
 * null note by design (the API has other callers).
 */
const NOTE_REQUIRED: AdSpendCategory[] = ["offline_event", "influencer"];

/** Currencies offered in the picker. Any ISO-4217 code is still accepted. */
const CURRENCIES = ["USD", "UAH", "EUR", "GBP", "PLN"];

interface PageState {
  token: string;
  link: AdSpendLinkPayload;
  rows: AdSpendRow[];
  notice: { kind: "ok" | "error"; text: string } | null;
  /** Sticky form values after a rejected submit, so nothing has to be retyped. */
  form: Partial<FormValues>;
}

interface AdSpendRow {
  id: string;
  channel: string;
  category: string;
  amount: number;
  currency: string;
  amountUsdCents: number;
  note: string | null;
}

interface FormValues {
  channel: string;
  category: string;
  periodStart: string;
  periodEnd: string;
  amount: string;
  currency: string;
  amountUsd: string;
  note: string;
}

// ── Auth ────────────────────────────────────────────────────────────────────

/**
 * The token in the path is the sole authorization, exactly as on the weekly
 * report page. Anything that does not verify gets an opaque 404 — never a 401
 * or a "link expired", which would confirm to a scanner that the route exists
 * and that tokens are worth guessing.
 */
function requireLink(req: Request, res: Response): AdSpendLinkPayload | null {
  const token = typeof req.params.token === "string" ? req.params.token : "";
  const link = verifyAdSpendLink(token);
  if (!link) {
    res.status(404).type("text/plain").send("Not found");
    return null;
  }
  return link;
}

/**
 * Reject a cross-site form post. The token already makes CSRF far-fetched (an
 * attacker who has the link can just open it), but a write endpoint reachable
 * by a plain HTML form is worth one cheap check: browsers send `Origin` on
 * every POST, so a mismatch is a forgery and an absent one is a non-browser
 * client. Same-origin posts from this very page always pass.
 */
function isSameOriginPost(req: Request): boolean {
  const origin = req.get("origin");
  if (!origin) return true; // curl, or a browser too old to send it
  try {
    return new URL(origin).host === req.get("host");
  } catch {
    return false;
  }
}

// ── Routes ──────────────────────────────────────────────────────────────────

founderAdSpendRouter.get("/ad-spend/:token", async (req: Request, res: Response) => {
  const link = requireLink(req, res);
  if (!link) return;
  const token = req.params.token as string;

  const noticeParam = typeof req.query.ok === "string" ? req.query.ok : "";
  const notice =
    noticeParam === "saved"
      ? { kind: "ok" as const, text: "Расход записан." }
      : noticeParam === "deleted"
        ? { kind: "ok" as const, text: "Запись удалена." }
        : null;

  await renderPage(res, 200, { token, link, rows: await loadRows(link), notice, form: {} });
});

/**
 * `express.urlencoded` is mounted on this route rather than on the app: the
 * public API is JSON-only everywhere else, and a global form parser would widen
 * every other endpoint's accepted content types for the sake of one page.
 */
founderAdSpendRouter.post(
  "/ad-spend/:token",
  express.urlencoded({ extended: false, limit: "16kb" }),
  async (req: Request, res: Response) => {
    const link = requireLink(req, res);
    if (!link) return;
    const token = req.params.token as string;

    if (!isSameOriginPost(req)) {
      res.status(403).type("text/plain").send("Forbidden");
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    // The channel arrives from one of two controls: a `<select>` of what
    // exists, and a free-text field for a campaign that does not exist yet.
    // The typed one wins — someone who took the trouble to type a slug over
    // a picked value meant the slug, and the reverse rule would silently
    // discard the only input a new campaign can be entered through.
    const typedChannel = str(body.channelNew).trim();
    const form: FormValues = {
      channel: typedChannel || str(body.channel).trim(),
      category: str(body.category),
      periodStart: str(body.periodStart) || link.weekStart,
      periodEnd: str(body.periodEnd) || link.weekEnd,
      amount: str(body.amount).trim(),
      currency: str(body.currency).trim().toUpperCase(),
      amountUsd: str(body.amountUsd).trim(),
      note: str(body.note).trim(),
    };

    const failure = await saveEntry(form, await loadKnownAdSpendChannels());
    if (failure) {
      await renderPage(res, 400, {
        token,
        link,
        rows: await loadRows(link),
        notice: { kind: "error", text: failure },
        form,
      });
      return;
    }

    // POST/redirect/GET: pulling to refresh on a phone must not re-submit.
    res.redirect(303, `/v1/founder/ad-spend/${encodeURIComponent(token)}?ok=saved`);
  },
);

/**
 * Delete one row. Re-submitting the same channel+category+period already EDITS
 * an entry (the upsert key), so this covers the one correction the founder
 * would otherwise have to reach a desktop for: a row logged against the wrong
 * channel, which the upsert can only ever add alongside the right one.
 */
founderAdSpendRouter.post(
  "/ad-spend/:token/delete",
  express.urlencoded({ extended: false, limit: "4kb" }),
  async (req: Request, res: Response) => {
    const link = requireLink(req, res);
    if (!link) return;
    const token = req.params.token as string;

    if (!isSameOriginPost(req)) {
      res.status(403).type("text/plain").send("Forbidden");
      return;
    }

    const id = str((req.body as Record<string, unknown> | undefined)?.id);
    // Scoped to rows this link's week actually shows: the token authorizes one
    // week, so it must not be able to delete an arbitrary row by id.
    const rows = await loadRows(link);
    if (rows.some((r) => r.id === id)) {
      await prisma.adSpend.delete({ where: { id } }).catch((err: unknown) => {
        console.warn("[founder-ad-spend] delete failed", { id, err });
      });
    }
    res.redirect(303, `/v1/founder/ad-spend/${encodeURIComponent(token)}?ok=deleted`);
  },
);

// ── Data ────────────────────────────────────────────────────────────────────

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Rows overlapping this link's week — the same overlap semantics the admin
 * list uses ("what touched this week"), so a two-week influencer buy shows up
 * here rather than looking unlogged and getting entered twice.
 */
async function loadRows(link: AdSpendLinkPayload): Promise<AdSpendRow[]> {
  const start = parseIsoDay(link.weekStart);
  const end = parseIsoDay(link.weekEnd);
  if (!start || !end) return [];
  const rows = await prisma.adSpend.findMany({
    where: { periodEnd: { gte: start }, periodStart: { lte: end } },
    orderBy: [{ periodStart: "desc" }, { channel: "asc" }],
    select: {
      id: true,
      channel: true,
      category: true,
      amount: true,
      currency: true,
      amountUsdCents: true,
      note: true,
    },
  });
  return rows;
}

/**
 * Validate and upsert. Returns a human-readable Russian reason on rejection,
 * `null` on success. Every rule here is the admin route's rule reached through
 * the same shared predicates — this page is a second client of `ad_spend`, not
 * a second definition of what a valid row is.
 */
async function saveEntry(form: FormValues, knownChannels: string[]): Promise<string | null> {
  if (!isAdSpendCategory(form.category)) return "Выбери категорию.";
  const category: AdSpendCategory = form.category;

  // Content/agency spend buys no trackable acquisition, so it can only be
  // logged against the sentinel channel. The dashboard form forces this in the
  // UI; here the server forces it, so a stale pick can't produce a 400 the
  // founder has to decode on a phone.
  const channel = categoryRequiresUnattributed(category)
    ? UNATTRIBUTED_CHANNEL
    : form.channel;

  if (!channel) return "Укажи канал.";
  // One rule, shared with `POST /admin/ad-spend` — this page is a second
  // client of `ad_spend`, not a second definition of what a valid row is.
  const verdict = classifyAdSpendChannel(channel, knownChannels, normalizeChannel);
  if (verdict === "not-normalized") {
    return `Канал «${channel}» не в том формате. Нужно: organic, referral, mobile, web:*, tg:<slug> или ${UNATTRIBUTED_CHANNEL}.`;
  }
  if (verdict === "unknown-shape") {
    return (
      `Канала «${channel}» ещё нет, и он не похож на ключ кампании. ` +
      `Новый пиши как tg:<slug> или web:<slug> (латиницей, без пробелов) — ` +
      `иначе на него никогда не сматчится ни одна регистрация.`
    );
  }
  if (!categoryRequiresUnattributed(category) && channel === UNATTRIBUTED_CHANNEL) {
    return `«${UNATTRIBUTED_CHANNEL}» только для категорий без окна атрибуции (продакшн, агентство).`;
  }

  const periodStart = parseIsoDay(form.periodStart);
  const periodEnd = parseIsoDay(form.periodEnd);
  if (!periodStart || !periodEnd) return "Не разобрал даты периода.";
  if (!isValidPeriod(periodStart, periodEnd)) return "Конец периода раньше начала.";

  const amountRaw = Number(form.amount.replace(",", "."));
  if (!Number.isFinite(amountRaw) || amountRaw <= 0) return "Сумма должна быть больше нуля.";
  // `AdSpend.amount` is an Int (whole currency units, not cents), so a decimal
  // has to be resolved before Prisma sees it. Rounding is announced in the
  // confirmation rather than done silently — the stored figure is shown back.
  const amount = Math.round(amountRaw);
  if (amount <= 0) return "Сумма округляется до нуля — укажи хотя бы 1.";

  if (!isValidCurrency(form.currency)) return "Валюта — три латинские буквы, например USD.";

  let amountUsdCents: number;
  if (form.amountUsd) {
    const usd = Number(form.amountUsd.replace(",", "."));
    if (!Number.isFinite(usd) || usd <= 0) return "Сумма в USD должна быть больше нуля.";
    amountUsdCents = Math.round(usd * 100);
  } else {
    const rate = APPROX_USD_RATE[form.currency];
    if (!rate) {
      return `Курс ${form.currency}→USD не зашит — впиши эквивалент в USD вручную.`;
    }
    amountUsdCents = Math.round(amount * rate * 100);
  }
  if (amountUsdCents <= 0) return "Эквивалент в USD округляется до нуля.";

  const note = form.note || null;
  if (NOTE_REQUIRED.includes(category) && !note) {
    return `Для категории «${CATEGORY_LABEL[category]}» нужна заметка — что именно купили.`;
  }

  try {
    await prisma.adSpend.upsert({
      where: {
        channel_category_periodStart_periodEnd: { channel, category, periodStart, periodEnd },
      },
      create: { channel, category, periodStart, periodEnd, amount, currency: form.currency, amountUsdCents, note },
      update: { amount, currency: form.currency, amountUsdCents, note },
    });
  } catch (err) {
    console.error("[founder-ad-spend] upsert failed", err);
    return "Не удалось сохранить — попробуй ещё раз.";
  }
  return null;
}

// ── Rendering ───────────────────────────────────────────────────────────────

function esc(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtDay(iso: string): string {
  const d = parseIsoDay(iso);
  if (!d) return iso;
  return d.toLocaleDateString("ru-RU", { timeZone: "UTC", day: "numeric", month: "long" });
}

function fmtUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

async function renderPage(res: Response, status: number, state: PageState): Promise<void> {
  const channels = await loadKnownAdSpendChannels();
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("Cache-Control", "private, no-store");
  res.status(status).type("html").send(renderHtml(state, channels));
}

/**
 * Everything below renders one screen for one thumb.
 *
 * The page is opened from a Telegram message, on a phone, to log a number the
 * founder already knows. That framing decides the layout, and three choices
 * here look odd on a desktop and are right on a phone:
 *
 *   1. **The form comes BEFORE the list of what is already logged.** The list
 *      is context; adding a row is the reason the link was tapped. With three
 *      entries logged, a list-first layout puts the first input below the fold.
 *      A one-line summary carries the context the list would have given.
 *   2. **Channel is a `<select>`, not the `<datalist>` this started as.** iOS
 *      Safari does not implement `<datalist>` for text inputs — the suggestion
 *      list simply never appears. On the one device this page exists for, the
 *      picker was an empty text box. A native `<select>` is the best control
 *      mobile has (a full-height wheel), and a separate free-text field covers
 *      the case a list cannot: a campaign slug with no signups behind it yet.
 *   3. **Period and the USD override live inside `<details>`.** Both are right
 *      as prefilled almost every time — the link names the week — and
 *      `<details>` is the one disclosure widget that needs no JavaScript.
 *
 * Every control is at least 48px tall for the same reason the delete button is
 * 44px: this is a form filled with a thumb, not a mouse.
 */

/** Chevron for the selects — `appearance: none` removes the native one, and
 * helmet's default CSP allows `img-src data:`, so no extra header is needed. */
const CHEVRON =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="8" viewBox="0 0 12 8"><path d="M1 1l5 5 5-5" stroke="#9a9aa2" stroke-width="1.8" fill="none" stroke-linecap="round"/></svg>`,
  );

function renderRows(state: PageState): string {
  if (state.rows.length === 0) {
    return `<p class="empty">За эту неделю ещё ничего не внесено.</p>`;
  }
  return `<ul class="rows">${state.rows
    .map((row) => {
      const cat = isAdSpendCategory(row.category) ? CATEGORY_LABEL[row.category] : row.category;
      const note = row.note ? `<div class="note">${esc(row.note)}</div>` : "";
      return `
      <li>
        <div class="row-main">
          <div class="row-text">
            <div class="row-channel">${esc(row.channel)}</div>
            <div class="row-meta">${esc(cat)} · ${row.amount} ${esc(row.currency)} · ${fmtUsd(row.amountUsdCents)}</div>
            ${note}
          </div>
          <form method="post" action="/v1/founder/ad-spend/${encodeURIComponent(state.token)}/delete">
            <input type="hidden" name="id" value="${esc(row.id)}">
            <button type="submit" class="del" aria-label="Удалить запись">✕</button>
          </form>
        </div>
      </li>`;
    })
    .join("")}</ul>`;
}

function renderHtml(state: PageState, channels: string[]): string {
  const { link, token, form } = state;
  const action = `/v1/founder/ad-spend/${encodeURIComponent(token)}`;
  const weekLabel = `${fmtDay(link.weekStart)} – ${fmtDay(link.weekEnd)}`;

  const categoryOptions = AD_SPEND_CATEGORIES.map((cat) => {
    const selected = (form.category ?? "performance_ads") === cat ? " selected" : "";
    const win = AD_SPEND_ATTRIBUTION_WINDOW_DAYS[cat];
    // Short suffix: a native iOS picker truncates a long option, and the
    // window is a hint rather than part of the name.
    const hint = win === null ? "без атриб." : `${win} дн.`;
    return `<option value="${cat}"${selected}>${esc(CATEGORY_LABEL[cat])} · ${hint}</option>`;
  }).join("");

  const currencyOptions = CURRENCIES.map((c) => {
    const selected = (form.currency ?? "UAH") === c ? " selected" : "";
    return `<option value="${c}"${selected}>${c}</option>`;
  }).join("");

  const channelOptions = [
    `<option value="">— выбери канал —</option>`,
    ...channels.map((c) => {
      const selected = form.channel === c ? " selected" : "";
      return `<option value="${esc(c)}"${selected}>${esc(c)}</option>`;
    }),
  ].join("");

  // A rejected submit whose channel was TYPED must come back in the field it
  // was typed into, not silently reappear as a selected option that does not
  // exist in the list.
  const typedChannel = form.channel && !channels.includes(form.channel) ? form.channel : "";

  const notice = state.notice
    ? `<div class="notice ${state.notice.kind}" role="status">${esc(state.notice.text)}</div>`
    : "";

  const totalUsd = state.rows.reduce((sum, r) => sum + r.amountUsdCents, 0);
  const summary =
    state.rows.length === 0
      ? `<div class="strip empty-strip">За эту неделю пока ничего не внесено</div>`
      : // "записей: N" rather than a declined "N записей": Russian plural
        // selection already exists twice in this repo (`founder-notify.ts` and
        // a private `slavicPlural` in shared i18n), and a third copy for one
        // label is worse than a phrasing that is correct for every N.
        `<div class="strip">Итого за неделю: <strong>${fmtUsd(totalUsd)}</strong> <span class="strip-sub">· записей: ${state.rows.length}</span></div>`;

  // Open the collapsed block when a rejected submit carried a period that is
  // NOT the week's default — otherwise the founder would be sent back to a
  // form whose offending field is hidden.
  const periodEdited =
    (form.periodStart != null && form.periodStart !== link.weekStart) ||
    (form.periodEnd != null && form.periodEnd !== link.weekEnd) ||
    Boolean(form.amountUsd);

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<title>Расходы · ${esc(weekLabel)}</title>
<style>
  :root { color-scheme: dark; --gold: #d9a441; --bg: #0b0b0d; --card: #141417; --line: #26262b; --field: #1d1d21; --muted: #9a9aa2; --faint: #6a6a72; }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  body {
    margin: 0; background: var(--bg); color: #f2f2f4;
    font: 16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    /* iPhone notch + home indicator. */
    padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
  }
  header { padding: 20px 16px 4px; max-width: 560px; margin: 0 auto; }
  h1 { margin: 0; font-size: 19px; letter-spacing: -0.01em; }
  .sub { color: var(--muted); font-size: 13px; margin-top: 3px; }
  main { padding: 6px 14px 40px; max-width: 560px; margin: 0 auto; }

  .strip { font-size: 14px; color: var(--muted); padding: 14px 2px 0; }
  .strip strong { color: #f2f2f4; }
  .strip-sub { color: var(--faint); }
  .empty-strip { color: var(--faint); }

  .card { background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 16px; margin: 10px 0; }
  h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: #8b8b93; margin: 0 0 12px; font-weight: 600; }

  label { display: block; font-size: 13px; color: var(--muted); margin: 14px 0 6px; }
  input, select {
    width: 100%; min-height: 48px; padding: 12px 13px;
    /* 16px is load-bearing: anything smaller makes iOS zoom the page on focus. */
    font-size: 16px; font-family: inherit;
    background: var(--field); color: #f2f2f4; border: 1px solid #33333a; border-radius: 12px;
  }
  select {
    appearance: none; -webkit-appearance: none;
    background-image: url("${CHEVRON}");
    background-repeat: no-repeat; background-position: right 14px center;
    padding-right: 38px;
  }
  input:focus, select:focus { outline: 2px solid var(--gold); outline-offset: -1px; }
  .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .pair.amount { grid-template-columns: 1.6fr 1fr; }
  .pair label { margin-top: 0; }
  .stack > * + * { margin-top: 8px; }
  .hint { font-size: 12px; color: var(--faint); margin-top: 7px; line-height: 1.45; }

  details { margin-top: 18px; border-top: 1px solid var(--line); padding-top: 14px; }
  summary {
    font-size: 13px; color: var(--muted); cursor: pointer; list-style: none;
    min-height: 34px; display: flex; align-items: center; gap: 7px;
  }
  summary::-webkit-details-marker { display: none; }
  summary::after { content: "▾"; color: var(--faint); font-size: 11px; }
  details[open] summary::after { content: "▴"; }

  button.save {
    width: 100%; margin-top: 20px; min-height: 52px; padding: 15px;
    font-size: 17px; font-weight: 600; font-family: inherit;
    background: var(--gold); color: #1a1400; border: 0; border-radius: 12px;
  }
  button.save:active { background: #c2913a; }

  .rows { list-style: none; margin: 0; padding: 0; }
  .rows li { border-bottom: 1px solid var(--line); }
  .rows li:last-child { border-bottom: 0; }
  .row-main { display: flex; gap: 8px; align-items: center; justify-content: space-between; }
  .row-text { min-width: 0; padding: 12px 0; }
  .row-channel { font-weight: 600; font-size: 15px; overflow-wrap: anywhere; }
  .row-meta { color: var(--muted); font-size: 13px; margin-top: 2px; }
  .note { color: #b9b9c0; font-size: 13px; font-style: italic; margin-top: 4px; overflow-wrap: anywhere; }
  /* 44px minimum: this control deletes a row, so a near-miss is the expensive
     kind of mistake. */
  .del { background: none; border: 0; color: var(--faint); font-size: 17px; min-width: 44px; min-height: 44px; flex: 0 0 auto; }
  .empty { color: var(--faint); margin: 0; font-size: 14px; }

  .notice { padding: 12px 14px; border-radius: 12px; font-size: 14px; margin: 12px 0 0; line-height: 1.45; }
  .notice.ok { background: #16301c; border: 1px solid #2c5c37; color: #b6e8c2; }
  .notice.error { background: #331819; border: 1px solid #5f2c2e; color: #f3bcbe; }
</style>
</head>
<body>
  <header>
    <h1>💸 Расходы на привлечение</h1>
    <div class="sub">Неделя ${esc(weekLabel)}</div>
  </header>
  <main>
    ${notice}

    <form class="card" method="post" action="${action}">
      <h2>Добавить расход</h2>

      <label for="amount">Сколько потратил</label>
      <div class="pair amount">
        <input id="amount" name="amount" type="number" inputmode="decimal" step="any" min="0"
               enterkeyhint="next" placeholder="5000" value="${esc(form.amount ?? "")}">
        <select id="currency" name="currency" aria-label="Валюта">${currencyOptions}</select>
      </div>

      <label for="channel">Канал</label>
      <div class="stack">
        <select id="channel" name="channel">${channelOptions}</select>
        <input id="channelNew" name="channelNew" type="text" autocapitalize="off" autocorrect="off"
               spellcheck="false" enterkeyhint="next" placeholder="или новый: tg:my_campaign"
               value="${esc(typedChannel)}">
      </div>
      <div class="hint">Нижнее поле — только для канала, которого ещё нет в списке; если оно заполнено, побеждает оно. Продакшн и агентство уходят на «${UNATTRIBUTED_CHANNEL}» сами, канал можно не трогать.</div>

      <label for="category">Категория</label>
      <select id="category" name="category">${categoryOptions}</select>
      <div class="hint">Число рядом с категорией — сколько дней после периода регистрация ещё засчитывается этой трате.</div>

      <label for="note">Заметка</label>
      <input id="note" name="note" enterkeyhint="done"
             placeholder="какой блогер / что за мероприятие" value="${esc(form.note ?? "")}">

      <details${periodEdited ? " open" : ""}>
        <summary>Период и курс — обычно менять не нужно</summary>
        <div class="pair">
          <div>
            <label for="periodStart">Начало</label>
            <input id="periodStart" name="periodStart" type="date" value="${esc(form.periodStart ?? link.weekStart)}">
          </div>
          <div>
            <label for="periodEnd">Конец</label>
            <input id="periodEnd" name="periodEnd" type="date" value="${esc(form.periodEnd ?? link.weekEnd)}">
          </div>
        </div>
        <label for="amountUsd">Эквивалент в USD</label>
        <input id="amountUsd" name="amountUsd" type="number" inputmode="decimal" step="0.01" min="0"
               placeholder="посчитаю сам по примерному курсу" value="${esc(form.amountUsd ?? "")}">
        <div class="hint">Записывается один раз и потом не пересчитывается — если курс важен, впиши точный.</div>
      </details>

      <button class="save" type="submit">Сохранить</button>
    </form>

    ${summary}

    <section class="card">
      <h2>Что уже внесено</h2>
      ${renderRows(state)}
    </section>
  </main>
</body>
</html>`;
}
