import express, { Router, type Request, type Response } from "express";
import { prisma } from "@gennety/db";
import { normalizeChannel } from "../../admin/utils/growth.js";
import {
  AD_SPEND_ATTRIBUTION_WINDOW_DAYS,
  AD_SPEND_CATEGORIES,
  UNATTRIBUTED_CHANNEL,
  categoryRequiresUnattributed,
  isAdSpendCategory,
  isSelfNormalizedChannel,
  isValidCurrency,
  isValidPeriod,
  type AdSpendCategory,
} from "../../admin/utils/ad-spend.js";
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

/** A deliberately-shaped campaign key: `tg:<slug>` / `web:<slug>`, the two
 * prefixes `normalizeChannel` keeps verbatim from a signup's deep link. */
const CAMPAIGN_CHANNEL_RE = /^(tg|web):[A-Za-z0-9_.-]+$/;

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
    const form: FormValues = {
      channel: str(body.channel).trim(),
      category: str(body.category),
      periodStart: str(body.periodStart) || link.weekStart,
      periodEnd: str(body.periodEnd) || link.weekEnd,
      amount: str(body.amount).trim(),
      currency: str(body.currency).trim().toUpperCase(),
      amountUsd: str(body.amountUsd).trim(),
      note: str(body.note).trim(),
    };

    const failure = await saveEntry(form, await loadChannelSuggestions());
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
 * Channel suggestions: every channel real signups have actually arrived
 * through, unioned with everything already logged. Offered as a `datalist`
 * rather than a closed `select` because a brand-new campaign slug has no
 * signups yet and must still be typeable — `isSelfNormalizedChannel` is what
 * keeps a typo from becoming a channel nothing can ever match.
 *
 * Unlike `GET /admin/ad-spend/channels` this does not run the full
 * test-account classification: that costs a scan of every user to remove a
 * handful of suggestions, and a suggestion is not a commitment. The validation
 * that actually protects the data is identical.
 */
async function loadChannelSuggestions(): Promise<string[]> {
  const [userRows, spendRows] = await Promise.all([
    prisma.user.findMany({ select: { referralSource: true }, distinct: ["referralSource"] }),
    prisma.adSpend.findMany({ select: { channel: true }, distinct: ["channel"] }),
  ]);
  const channels = new Set<string>([UNATTRIBUTED_CHANNEL]);
  for (const row of userRows) channels.add(normalizeChannel(row.referralSource));
  for (const row of spendRows) channels.add(row.channel);
  return [...channels].sort();
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
  if (!isSelfNormalizedChannel(channel, normalizeChannel)) {
    return `Канал «${channel}» не в том формате. Нужно: organic, referral, mobile, web:*, tg:<slug> или ${UNATTRIBUTED_CHANNEL}.`;
  }
  // `isSelfNormalizedChannel` alone is a weaker guard than it looks:
  // `normalizeChannel` is the identity function for anything that isn't a
  // `referral`/`web:`/`mobile` string, so free text like "Instagram Ads"
  // re-normalizes to itself and passes. On the dashboard the closed `<select>`
  // is what really prevents a ghost channel; this page's field is open (a
  // brand-new campaign slug has no signups yet and must stay typeable), so the
  // check the design doc promises has to be made here: either a channel that
  // already exists, or something deliberately shaped like a campaign key.
  if (!knownChannels.includes(channel) && !CAMPAIGN_CHANNEL_RE.test(channel)) {
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
  const channels = await loadChannelSuggestions();
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("Cache-Control", "private, no-store");
  res.status(status).type("html").send(renderHtml(state, channels));
}

function renderRows(state: PageState): string {
  if (state.rows.length === 0) {
    return `<p class="empty">За эту неделю ещё ничего не внесено.</p>`;
  }
  const totalUsd = state.rows.reduce((sum, r) => sum + r.amountUsdCents, 0);
  const items = state.rows
    .map((row) => {
      const cat = isAdSpendCategory(row.category) ? CATEGORY_LABEL[row.category] : row.category;
      const note = row.note ? `<div class="note">${esc(row.note)}</div>` : "";
      return `
      <li>
        <div class="row-main">
          <div>
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
    .join("");
  return `<ul class="rows">${items}</ul>
    <div class="total">Итого за неделю: <strong>${fmtUsd(totalUsd)}</strong></div>`;
}

function renderHtml(state: PageState, channels: string[]): string {
  const { link, token, form } = state;
  const action = `/v1/founder/ad-spend/${encodeURIComponent(token)}`;

  const categoryOptions = AD_SPEND_CATEGORIES.map((cat) => {
    const selected = (form.category ?? "performance_ads") === cat ? " selected" : "";
    const win = AD_SPEND_ATTRIBUTION_WINDOW_DAYS[cat];
    const hint = win === null ? "без атрибуции" : `окно ${win} дн.`;
    return `<option value="${cat}"${selected}>${esc(CATEGORY_LABEL[cat])} — ${hint}</option>`;
  }).join("");

  const currencyOptions = CURRENCIES.map((c) => {
    const selected = (form.currency ?? "UAH") === c ? " selected" : "";
    return `<option value="${c}"${selected}>${c}</option>`;
  }).join("");

  const datalist = channels
    .map((c) => `<option value="${esc(c)}"></option>`)
    .join("");

  const notice = state.notice
    ? `<div class="notice ${state.notice.kind}">${esc(state.notice.text)}</div>`
    : "";

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Расходы на привлечение · ${esc(fmtDay(link.weekStart))} – ${esc(fmtDay(link.weekEnd))}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0b0b0d; color: #f2f2f4; font: 16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  header { padding: 22px 16px 6px; }
  h1 { margin: 0; font-size: 20px; }
  .sub { color: #9a9aa2; font-size: 13px; margin-top: 4px; }
  main { padding: 8px 14px 48px; max-width: 560px; margin: 0 auto; }
  .card { background: #141417; border: 1px solid #26262b; border-radius: 14px; padding: 14px; margin: 12px 0; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .05em; color: #8b8b93; margin: 0 0 10px; font-weight: 600; }
  label { display: block; font-size: 13px; color: #9a9aa2; margin: 12px 0 5px; }
  input, select, textarea {
    width: 100%; padding: 11px 12px; font-size: 16px; font-family: inherit;
    background: #1d1d21; color: #f2f2f4; border: 1px solid #33333a; border-radius: 10px;
  }
  input:focus, select:focus, textarea:focus { outline: 2px solid #d9a441; outline-offset: -1px; }
  .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .hint { font-size: 12px; color: #6a6a72; margin-top: 5px; }
  button.save {
    width: 100%; margin-top: 18px; padding: 14px; font-size: 16px; font-weight: 600;
    background: #d9a441; color: #1a1400; border: 0; border-radius: 10px;
  }
  .rows { list-style: none; margin: 0; padding: 0; }
  .rows li { border-bottom: 1px solid #26262b; padding: 10px 0; }
  .rows li:last-child { border-bottom: 0; }
  .row-main { display: flex; gap: 10px; align-items: flex-start; justify-content: space-between; }
  .row-channel { font-weight: 600; font-size: 15px; }
  .row-meta { color: #9a9aa2; font-size: 13px; margin-top: 2px; }
  .note { color: #b9b9c0; font-size: 13px; font-style: italic; margin-top: 4px; }
  /* 44px is the minimum comfortable touch target; this control deletes a row,
     so a near-miss is the expensive kind of mistake. */
  .del { background: none; border: 0; color: #6a6a72; font-size: 18px; min-width: 44px; min-height: 44px; }
  .total { margin-top: 12px; padding-top: 10px; border-top: 1px solid #26262b; font-size: 14px; color: #9a9aa2; }
  .total strong { color: #f2f2f4; }
  .empty { color: #6a6a72; margin: 0; font-size: 14px; }
  .notice { padding: 11px 13px; border-radius: 10px; font-size: 14px; margin: 12px 0; }
  .notice.ok { background: #16301c; border: 1px solid #2c5c37; color: #b6e8c2; }
  .notice.error { background: #331819; border: 1px solid #5f2c2e; color: #f3bcbe; }
</style>
</head>
<body>
  <header>
    <h1>💸 Расходы на привлечение</h1>
    <div class="sub">Неделя ${esc(fmtDay(link.weekStart))} – ${esc(fmtDay(link.weekEnd))}</div>
  </header>
  <main>
    ${notice}

    <section class="card">
      <h2>Уже внесено</h2>
      ${renderRows(state)}
    </section>

    <form class="card" method="post" action="${action}">
      <h2>Добавить расход</h2>

      <label for="category">Категория</label>
      <select id="category" name="category">${categoryOptions}</select>

      <label for="channel">Канал</label>
      <input id="channel" name="channel" list="channels" autocapitalize="off" autocorrect="off"
             placeholder="tg:my_campaign" value="${esc(form.channel ?? "")}">
      <datalist id="channels">${datalist}</datalist>
      <div class="hint">Продакшн и агентство пишутся на «${UNATTRIBUTED_CHANNEL}» — поле можно оставить пустым, подставится само.</div>

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

      <div class="pair">
        <div>
          <label for="amount">Сумма</label>
          <!-- step="any", not "1": the stored column is an Int and the server
               rounds, but a browser told step="1" refuses to submit "1500.50"
               at all, which would block the very input the rounding exists for. -->
          <input id="amount" name="amount" type="number" inputmode="decimal" step="any" min="0"
                 placeholder="5000" value="${esc(form.amount ?? "")}">
        </div>
        <div>
          <label for="currency">Валюта</label>
          <select id="currency" name="currency">${currencyOptions}</select>
        </div>
      </div>

      <label for="amountUsd">Эквивалент в USD <span class="hint">— необязательно</span></label>
      <input id="amountUsd" name="amountUsd" type="number" inputmode="decimal" step="0.01" min="0"
             placeholder="посчитаю сам по примерному курсу" value="${esc(form.amountUsd ?? "")}">
      <div class="hint">Записывается один раз и потом не пересчитывается — если курс важен, впиши точный.</div>

      <label for="note">Заметка</label>
      <input id="note" name="note" placeholder="какой блогер / что за мероприятие" value="${esc(form.note ?? "")}">

      <button class="save" type="submit">Сохранить</button>
    </form>
  </main>
</body>
</html>`;
}
