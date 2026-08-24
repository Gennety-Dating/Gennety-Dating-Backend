import { Router, type Request, type Response } from "express";
import { prisma } from "@gennety/db";
import {
  t,
  type Language,
  buildSubInvoicePayload,
  subProductForPlan,
  premiumPlanById,
  premiumPlanStars,
  premiumPlanDiscountPct,
  premiumPlanDisplayPrice,
  premiumPlanPerMonthDisplay,
  PREMIUM_PLANS,
  DEFAULT_PREMIUM_PLAN_ID,
  PREMIUM_SUBSCRIPTION_PERIOD_SECONDS,
  type PremiumPlan,
} from "@gennety/shared";
import { env } from "../../config.js";
import { DEMO_MODE_ENABLED } from "../../demo/config.js";
import { validateInitData } from "../init-data.js";
import { getPremiumState } from "../../services/premium.js";

/**
 * Gennety Premium Mini App endpoints (PRODUCT_SPEC §Premium). TMA-authed
 * (`Authorization: tma <initData>`) like the ticket / venue-change Mini Apps.
 * Mounted at `/v1/premium`.
 *
 *   GET  /v1/premium/state          — subscription state + price
 *   POST /v1/premium/stars-invoice  — mint the recurring Stars subscription link
 *
 * The wallet-style trust boundary is the bot's `successful_payment` handler
 * (handlers/payments.ts), keyed on the `sub:premium` payload — including every
 * 30-day auto-renewal. This router only reads state and mints the invoice link.
 */
export function createPremiumRouter(): Router {
  const router = Router();

  router.get("/state", async (req: Request, res: Response): Promise<void> => {
    const auth = authenticate(req);
    if (!auth.ok) {
      res.status(401).json(auth.body);
      return;
    }
    const user = await prisma.user.findUnique({
      where: { telegramId: BigInt(auth.user.id) },
      select: { id: true },
    });
    if (!user) {
      res.status(404).json({ error: "user-not-found" });
      return;
    }
    const state = await getPremiumState(user.id);
    res.status(200).json({
      ok: true,
      featureEnabled: env.PREMIUM_FEATURE_ENABLED,
      active: state.active,
      premiumUntil: state.premiumUntil?.toISOString() ?? null,
      autoRenew: state.autoRenew,
      provider: state.provider,
      priceStars: env.PREMIUM_STARS,
      priceDisplay: env.PREMIUM_PRICE_USD_DISPLAY,
      // The full plan catalog, priced server-side. The Mini App renders what it
      // is told rather than deriving prices of its own: a bundle computing
      // `stars × months × 0.85` locally is a second implementation of the
      // discount that a cached older client keeps applying after a repricing,
      // and it would be the half the user sees.
      plans: offeredPlans().map((plan) => ({
        id: plan.id,
        months: plan.months,
        recurring: plan.recurring,
        stars: premiumPlanStars(plan, env.PREMIUM_STARS),
        discountPct: premiumPlanDiscountPct(plan),
        priceDisplay: premiumPlanDisplayPrice(
          plan,
          env.PREMIUM_STARS,
          env.PREMIUM_PRICE_USD_DISPLAY,
        ),
        perMonthDisplay: premiumPlanPerMonthDisplay(
          plan,
          env.PREMIUM_STARS,
          env.PREMIUM_PRICE_USD_DISPLAY,
        ),
      })),
      // Drives the "invite a friend instead" referral cross-promo link, shown
      // client-side only on the sales screen (never once already subscribed).
      referralEnabled: env.REFERRAL_FEATURE_ENABLED,
    });
  });

  router.post("/stars-invoice", async (req: Request, res: Response): Promise<void> => {
    const auth = authenticate(req);
    if (!auth.ok) {
      res.status(401).json(auth.body);
      return;
    }
    if (!env.PREMIUM_FEATURE_ENABLED) {
      res.status(404).json({ error: "premium-not-enabled" });
      return;
    }
    const user = await prisma.user.findUnique({
      where: { telegramId: BigInt(auth.user.id) },
      select: { id: true, language: true },
    });
    if (!user) {
      res.status(404).json({ error: "user-not-found" });
      return;
    }
    const { getBotApi } = await import("../server.js");
    const api = getBotApi();
    if (!api) {
      res.status(503).json({ error: "bot-unavailable" });
      return;
    }
    // Which plan. A body with no `plan` is an older bundle, which only ever
    // meant the monthly subscription — so it falls back rather than failing.
    // An UNKNOWN plan is refused instead: that is a client asking for something
    // this server cannot price, and guessing would charge for a period nobody
    // chose.
    const requested = (req.body as { plan?: unknown } | undefined)?.plan;
    const resolved =
      requested === undefined || requested === null
        ? premiumPlanById(DEFAULT_PREMIUM_PLAN_ID)
        : premiumPlanById(typeof requested === "string" ? requested : null);
    // Refused rather than merely hidden: the catalog is the client's list, not
    // the boundary. See `offeredPlans`.
    const plan =
      resolved && offeredPlans().some((p) => p.id === resolved.id) ? resolved : null;
    if (!plan) {
      res.status(400).json({ error: "unknown-plan" });
      return;
    }

    const lang = (user.language ?? "en") as Language;
    const stars = premiumPlanStars(plan, env.PREMIUM_STARS);
    try {
      // Monthly = a RECURRING Stars subscription (`subscription_period`, which
      // Telegram supports only at 30 days). The 3/6-month packages are ordinary
      // ONE-TIME invoices — that option is not merely unused here, it does not
      // exist: Telegram has no 90- or 180-day period, so a package cannot be
      // sold as a native renewing subscription at all. What replaces the
      // renewal is the expiry reminder (§3.8).
      //
      // Empty provider token + XTR = Stars, no merchant account needed.
      const link = await api.createInvoiceLink(
        t(lang, "premiumInvoiceTitle"),
        planDescription(lang, plan.months),
        buildSubInvoicePayload(subProductForPlan(plan.id)),
        "",
        "XTR",
        [{ label: planLabel(lang, plan.months), amount: stars }],
        plan.recurring
          ? { subscription_period: PREMIUM_SUBSCRIPTION_PERIOD_SECONDS }
          : {},
      );
      res.status(200).json({ ok: true, link, stars, plan: plan.id });
    } catch (err) {
      console.error(`[premium] createInvoiceLink (${plan.id}) failed:`, err);
      res.status(502).json({ error: "invoice-failed" });
    }
  });

  return router;
}

/**
 * The plans this deployment will actually sell.
 *
 * Demo mode (DEMO_MODE.md) gets the MONTHLY plan only. The demo has no mock
 * rail for Stars — `TICKET_STARS_ENABLED` is false there and
 * `assertDemoIsolation` refuses to boot with it on, precisely because "Telegram
 * Stars moves real money out of a visitor's real Telegram balance" — yet this
 * route has never consulted that flag, so tapping Subscribe in the demo already
 * mints a real invoice for a real charge. That is pre-existing, and it is the
 * reason the packages stay out: they would raise what one accidental tap costs
 * a visitor from 750⭐ to 3150⭐ (~$18 → ~$75). Capping here changes nothing
 * about what the demo shows today; closing the underlying hole is a separate
 * decision about whether the demo should be able to charge at all.
 */
function offeredPlans(): readonly PremiumPlan[] {
  // Demo mode: monthly only — see above.
  if (DEMO_MODE_ENABLED) return PREMIUM_PLANS.filter((p) => p.recurring);
  return PREMIUM_PLANS;
}

/**
 * Invoice line label / description. The monthly plan keeps its existing wording
 * verbatim — that string is what an already-subscribed user sees on every
 * renewal receipt, so changing it would rewrite the paper trail of a purchase
 * they made under the old text. Packages get the month count spliced into the
 * shared plan-name key instead of five more copies of the sentence.
 */
function planLabel(lang: Language, months: number): string {
  if (months === 1) return t(lang, "premiumInvoiceLabel");
  return `Gennety Premium — ${t(lang, months === 3 ? "premiumPlan3Months" : "premiumPlan6Months")}`;
}

function planDescription(lang: Language, months: number): string {
  if (months === 1) return t(lang, "premiumInvoiceDesc");
  return planLabel(lang, months);
}

type AuthOk = { ok: true; user: { id: number } };
type AuthErr = { ok: false; body: { error: string; reason?: string } };

function authenticate(req: Request): AuthOk | AuthErr {
  const authHeader = req.header("authorization") ?? req.header("Authorization");
  if (!authHeader?.startsWith("tma ")) {
    return { ok: false, body: { error: "Missing tma initData" } };
  }
  const initData = authHeader.slice(4).trim();
  if (!initData) return { ok: false, body: { error: "Empty initData" } };
  const validation = validateInitData(initData, env.BOT_TOKEN);
  if (!validation.valid) {
    return { ok: false, body: { error: "Invalid initData", reason: validation.reason } };
  }
  return { ok: true, user: { id: validation.user.id } };
}
