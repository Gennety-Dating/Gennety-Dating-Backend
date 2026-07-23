import { Router, type Request, type Response } from "express";
import { prisma } from "@gennety/db";
import { downloadProfileImage } from "../../services/storage.js";
import { getMainBotApi } from "../../services/main-bot-api.js";
import type {
  WeeklyMatchesReport,
  WeeklyMatchesUserCard,
} from "../../services/weekly-matches-report.js";

/**
 * Founder weekly-matches report page (PII, ops-only). Tokenized, login-free —
 * the unguessable `FounderReport.token` in the path is the sole authorization,
 * so the founder can open it with one tap from Telegram on a phone. The page is
 * `noindex` and the media proxy only serves photo refs that appear in THIS
 * report's snapshot, so it can't be turned into an arbitrary image proxy.
 *
 * Gated implicitly by `FOUNDER_NOTIFY_ENABLED`: reports are only ever created by
 * `notifyFounderWeeklyMatches`, which is a no-op when the feature is off.
 */
export const founderReportRouter: Router = Router();

const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

interface LoadedReport {
  report: WeeklyMatchesReport;
  weekOf: Date;
  allowedRefs: Set<string>;
}

async function loadReport(token: string): Promise<LoadedReport | null> {
  if (!TOKEN_RE.test(token)) return null;
  const row = await prisma.founderReport.findUnique({ where: { token } });
  if (!row) return null;
  const report = row.dataJson as unknown as WeeklyMatchesReport;
  const allowedRefs = new Set<string>();
  for (const pair of report.pairs) {
    for (const u of pair.users) for (const ref of u.photoRefs) allowedRefs.add(ref);
  }
  return { report, weekOf: row.weekOf, allowedRefs };
}

// ── HTML page ───────────────────────────────────────────────────────────────
founderReportRouter.get("/report/:token", async (req: Request, res: Response) => {
  const token = typeof req.params.token === "string" ? req.params.token : "";
  const loaded = await loadReport(token);
  if (!loaded) {
    res.status(404).type("text/plain").send("Not found");
    return;
  }
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("Cache-Control", "private, no-store");
  res.status(200).type("html").send(renderReportHtml(token, loaded));
});

// ── Media proxy (only refs present in this report) ───────────────────────────
founderReportRouter.get(
  "/report/:token/media",
  async (req: Request, res: Response) => {
    const token = typeof req.params.token === "string" ? req.params.token : "";
    const loaded = await loadReport(token);
    if (!loaded) {
      res.status(404).end();
      return;
    }
    const ref = typeof req.query.ref === "string" ? req.query.ref : "";
    if (!ref || !loaded.allowedRefs.has(ref)) {
      res.status(404).end();
      return;
    }
    const api = getMainBotApi();
    if (!api) {
      res.status(503).end();
      return;
    }
    try {
      const buf = await downloadProfileImage(ref, api);
      if (!buf) {
        res.status(404).end();
        return;
      }
      res.setHeader("Content-Type", "image/jpeg");
      // PII (real user photos) behind a token-in-URL sole-auth boundary — never
      // let a browser retain a copy after the tab closes (matches the report
      // page's own `no-store` above).
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("X-Robots-Tag", "noindex");
      res.status(200).end(buf);
    } catch {
      res.status(404).end();
    }
  },
);

// ── Rendering ────────────────────────────────────────────────────────────────
function esc(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function mediaUrl(token: string, ref: string): string {
  return `/v1/founder/report/${encodeURIComponent(token)}/media?ref=${encodeURIComponent(ref)}`;
}

function userColumn(token: string, u: WeeklyMatchesUserCard): string {
  const name = esc(u.firstName ?? "—");
  const age = u.age != null ? `, ${u.age}` : "";
  const meta: string[] = [];
  if (u.gender) meta.push(esc(u.gender));
  if (u.city) meta.push(esc(u.city));
  meta.push(esc(u.verificationStatus));
  const score =
    u.attractiveness != null
      ? `<span class="score">⭐ ${u.attractiveness}/100</span>`
      : `<span class="score muted">— no score</span>`;
  const photos = u.photoRefs
    .map((ref) => `<img loading="lazy" src="${mediaUrl(token, ref)}" alt="">`)
    .join("");
  return `
    <div class="user">
      <div class="uname">${name}${age}</div>
      <div class="umeta">${meta.join(" · ")}</div>
      ${score}
      <div class="photos">${photos}</div>
    </div>`;
}

function renderReportHtml(token: string, loaded: LoadedReport): string {
  const { report, weekOf } = loaded;
  const week = weekOf.toLocaleDateString("ru-RU", {
    timeZone: "Europe/Kyiv",
    dateStyle: "long",
  });
  const cards = report.pairs
    .map((pair) => {
      const synergy =
        pair.synergyScore != null
          ? `<span class="synergy">Synergy ${pair.synergyScore}</span>`
          : "";
      const reason = pair.synergyReason ? `<div class="reason">${esc(pair.synergyReason)}</div>` : "";
      return `
      <section class="pair">
        <div class="pair-head">
          <span class="status">${esc(pair.status)}</span>
          ${synergy}
        </div>
        <div class="cols">
          ${userColumn(token, pair.users[0])}
          <div class="vs">✕</div>
          ${userColumn(token, pair.users[1])}
        </div>
        ${reason}
      </section>`;
    })
    .join("");

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Матчи недели · ${esc(week)}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0b0b0d; color: #f2f2f4; font: 15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  header { padding: 20px 16px 8px; }
  h1 { margin: 0; font-size: 20px; }
  .sub { color: #9a9aa2; font-size: 13px; margin-top: 4px; }
  main { padding: 8px 12px 40px; max-width: 720px; margin: 0 auto; }
  .pair { background: #141417; border: 1px solid #26262b; border-radius: 14px; padding: 14px; margin: 12px 0; }
  .pair-head { display: flex; gap: 10px; align-items: center; margin-bottom: 10px; }
  .status { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: #8b8b93; }
  .synergy { margin-left: auto; font-size: 12px; color: #d9a441; }
  .cols { display: grid; grid-template-columns: 1fr auto 1fr; gap: 8px; align-items: start; }
  .vs { align-self: center; color: #6a6a72; font-size: 14px; }
  .user { min-width: 0; }
  .uname { font-weight: 600; }
  .umeta { color: #9a9aa2; font-size: 12px; margin: 2px 0 6px; }
  .score { display: inline-block; font-size: 12px; color: #d9a441; margin-bottom: 6px; }
  .score.muted { color: #6a6a72; }
  .photos { display: flex; flex-wrap: wrap; gap: 4px; }
  .photos img { width: 62px; height: 62px; object-fit: cover; border-radius: 8px; background: #222; }
  .reason { margin-top: 10px; color: #b9b9c0; font-size: 13px; font-style: italic; }
  .empty { color: #9a9aa2; padding: 24px 4px; }
</style>
</head>
<body>
  <header>
    <h1>🗓 Матчи недели</h1>
    <div class="sub">${esc(week)} · ${report.pairs.length} пар</div>
  </header>
  <main>
    ${cards || `<div class="empty">Пар за эту неделю нет.</div>`}
  </main>
</body>
</html>`;
}
