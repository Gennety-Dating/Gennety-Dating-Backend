import { Router, type Request, type Response } from "express";
import { prisma } from "@gennety/db";
import { isUuid } from "../utils/uuid.js";
import { classifyAllUsers } from "../utils/user-health-source.js";
import { normalizeChannel } from "../utils/growth.js";
import {
  AD_SPEND_CATEGORIES,
  UNATTRIBUTED_CHANNEL,
  categoryRequiresUnattributed,
  isAdSpendCategory,
  isSelfNormalizedChannel,
  isValidCurrency,
  isValidPeriod,
} from "../utils/ad-spend.js";

/**
 * `/admin/ad-spend` — the founder's own record of acquisition spend
 * (AD_SPEND_TRACKING_DESIGN.md), read by `computeAcquisitionCost` in
 * `/admin/dashboard`.
 *
 * Small volume by construction — the founder enters this by hand, roughly
 * weekly — so this list is unpaginated, unlike `/admin/purchases`.
 */

const DEFAULT_LIMIT = 500;

function parseDate(raw: unknown): Date | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function serialize(row: {
  id: string;
  channel: string;
  category: string;
  periodStart: Date;
  periodEnd: Date;
  amount: number;
  currency: string;
  amountUsdCents: number;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    ...row,
    periodStart: row.periodStart.toISOString(),
    periodEnd: row.periodEnd.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const adSpendRouter: Router = Router();

adSpendRouter.get("/admin/ad-spend", async (req: Request, res: Response) => {
  try {
    const channel = typeof req.query.channel === "string" ? req.query.channel : undefined;
    const category = typeof req.query.category === "string" ? req.query.category : undefined;
    const from = parseDate(req.query.from);
    const to = parseDate(req.query.to);

    const rows = await prisma.adSpend.findMany({
      where: {
        ...(channel ? { channel } : {}),
        ...(category ? { category } : {}),
        // Overlap with [from, to], not containment: a founder asking "what
        // touched August" wants a spend row that started in July and ran
        // into August too, not only rows fully inside the window.
        ...(from ? { periodEnd: { gte: from } } : {}),
        ...(to ? { periodStart: { lte: to } } : {}),
      },
      orderBy: { periodStart: "desc" },
      take: DEFAULT_LIMIT,
    });

    res.json({ data: rows.map(serialize), total: rows.length });
  } catch (err) {
    console.error("[admin] ad-spend list error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * The channel picker's option list — real users' own first-touch channels,
 * unioned with whatever has already been logged, plus the sentinel. Never
 * free text on the client: a typo'd channel would log spend that no signup
 * can ever join against, silently.
 */
adSpendRouter.get("/admin/ad-spend/channels", async (_req: Request, res: Response) => {
  try {
    const [health, userRows, spendRows] = await Promise.all([
      // Взято ТОЛЬКО ради вердикта «тестовый»; сама классификация живёт в
      // одном месте (`user-health.ts`) — тот же приём, что уже применяет
      // `monetization-source.ts`.
      classifyAllUsers(),
      prisma.user.findMany({ select: { id: true, referralSource: true } }),
      prisma.adSpend.findMany({ select: { channel: true }, distinct: ["channel"] }),
    ]);

    const testIds = new Set(
      health.users.filter((u) => u.verdict.classification === "test").map((u) => u.id),
    );
    const channels = new Set<string>([UNATTRIBUTED_CHANNEL]);
    for (const row of userRows) {
      if (testIds.has(row.id)) continue;
      channels.add(normalizeChannel(row.referralSource));
    }
    for (const row of spendRows) channels.add(row.channel);

    res.json({ channels: [...channels].sort() });
  } catch (err) {
    console.error("[admin] ad-spend channels error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

adSpendRouter.post("/admin/ad-spend", async (req: Request, res: Response) => {
  try {
    const body = req.body as Record<string, unknown>;
    const channel = typeof body.channel === "string" ? body.channel.trim() : "";
    const category = typeof body.category === "string" ? body.category : "";
    const periodStart = parseDate(body.periodStart);
    const periodEnd = parseDate(body.periodEnd);
    const amount = typeof body.amount === "number" ? body.amount : Number(body.amount);
    // No case-coercion: `isValidCurrency` deliberately rejects "usd" (see
    // ad-spend.test.ts), and silently uppercasing here would defeat that —
    // the dashboard form is where "always type uppercase" belongs.
    const currency = typeof body.currency === "string" ? body.currency.trim() : "";
    const amountUsdCents =
      typeof body.amountUsdCents === "number" ? body.amountUsdCents : Number(body.amountUsdCents);
    const note = typeof body.note === "string" && body.note.trim() ? body.note.trim() : null;

    if (!isAdSpendCategory(category)) {
      res.status(400).json({ error: `category must be one of ${AD_SPEND_CATEGORIES.join(", ")}` });
      return;
    }
    if (!isSelfNormalizedChannel(channel, normalizeChannel)) {
      res.status(400).json({
        error:
          `channel must already be normalized (organic | referral | mobile | web:* | ` +
          `tg:<slug>) or the literal "${UNATTRIBUTED_CHANNEL}"`,
      });
      return;
    }
    const requiresUnattributed = categoryRequiresUnattributed(category);
    if (requiresUnattributed && channel !== UNATTRIBUTED_CHANNEL) {
      res
        .status(400)
        .json({ error: `category "${category}" carries no attribution window — log it against "${UNATTRIBUTED_CHANNEL}"` });
      return;
    }
    if (!requiresUnattributed && channel === UNATTRIBUTED_CHANNEL) {
      res.status(400).json({
        error: `"${UNATTRIBUTED_CHANNEL}" is only for categories with no attribution window (content_production, agency)`,
      });
      return;
    }
    if (!isValidCurrency(currency)) {
      res.status(400).json({ error: "currency must be a 3-letter ISO-4217 code" });
      return;
    }
    if (!periodStart || !periodEnd || !isValidPeriod(periodStart, periodEnd)) {
      res.status(400).json({ error: "periodStart/periodEnd must be valid dates with periodEnd >= periodStart" });
      return;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      res.status(400).json({ error: "amount must be a positive number" });
      return;
    }
    if (!Number.isInteger(amountUsdCents) || amountUsdCents < 0) {
      res.status(400).json({ error: "amountUsdCents must be a non-negative integer" });
      return;
    }

    const row = await prisma.adSpend.upsert({
      where: { channel_category_periodStart_periodEnd: { channel, category, periodStart, periodEnd } },
      create: { channel, category, periodStart, periodEnd, amount, currency, amountUsdCents, note },
      update: { amount, currency, amountUsdCents, note },
    });

    res.json({ data: serialize(row) });
  } catch (err) {
    console.error("[admin] ad-spend upsert error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

adSpendRouter.delete("/admin/ad-spend/:id", async (req: Request, res: Response) => {
  try {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) {
      res.status(400).json({ error: "id must be a UUID" });
      return;
    }
    await prisma.adSpend.delete({ where: { id } });
    res.json({ ok: true });
  } catch (err) {
    // A delete on a row that no longer exists is P2025, not a real failure —
    // the caller's intent (this row should not exist) is already satisfied.
    if (typeof err === "object" && err !== null && "code" in err && err.code === "P2025") {
      res.json({ ok: true });
      return;
    }
    console.error("[admin] ad-spend delete error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
