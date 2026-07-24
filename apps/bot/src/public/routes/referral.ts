import { createHmac, timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { prisma } from "@gennety/db";
import { t, type Language } from "@gennety/shared";
import { env } from "../../config.js";
import { validateInitData } from "../init-data.js";
import { buildReferralLink, buildReferralStateView } from "../../services/referral.js";
import { renderReferralCard } from "../../services/referral-card/index.js";

/**
 * Referral Mini App endpoints (§Referral). TMA-authed (`Authorization: tma
 * <initData>`) like the ticket / premium Mini Apps, except `GET /card` which is
 * a PUBLIC signed image endpoint (Telegram fetches it when rendering the shared
 * photo, so it can't carry initData). Mounted at `/v1/referral`, feature-gated.
 *
 *   GET  /v1/referral/state          — ladder + progress + $ value + invite link
 *   POST /v1/referral/share-message  — mint a one-tap savePreparedInlineMessage
 *   GET  /v1/referral/card?u=&sig=    — render the invite card PNG (public, HMAC)
 */

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

/** Short HMAC over the referrer id so only bot-minted card URLs render. */
function cardSig(referrerId: string): string {
  return createHmac("sha256", env.BOT_TOKEN)
    .update(`referral-card:${referrerId}`)
    .digest("hex")
    .slice(0, 24);
}

export function createReferralRouter(): Router {
  const router = Router();

  router.get("/state", async (req: Request, res: Response): Promise<void> => {
    const auth = authenticate(req);
    if (!auth.ok) {
      res.status(401).json(auth.body);
      return;
    }
    const user = await prisma.user.findUnique({
      where: { telegramId: BigInt(auth.user.id) },
      select: { id: true, language: true, referralVerifiedCount: true },
    });
    if (!user) {
      res.status(404).json({ error: "user-not-found" });
      return;
    }

    res.status(200).json({
      ok: true,
      ...buildReferralStateView(user.id, user.referralVerifiedCount, env.BOT_USERNAME),
    });
  });

  router.post("/share-message", async (req: Request, res: Response): Promise<void> => {
    const auth = authenticate(req);
    if (!auth.ok) {
      res.status(401).json(auth.body);
      return;
    }
    const { getBotApi } = await import("../server.js");
    const api = getBotApi();
    if (!api) {
      res.status(503).json({ error: "bot-api-unavailable" });
      return;
    }
    const user = await prisma.user.findUnique({
      where: { telegramId: BigInt(auth.user.id) },
      select: { id: true, firstName: true, language: true },
    });
    if (!user) {
      res.status(404).json({ error: "user-not-found" });
      return;
    }

    const lang = (user.language ?? "en") as Language;
    const link = buildReferralLink(user.id, env.BOT_USERNAME);
    const caption = t(lang, "referralShareCaption");
    const keyboard = { inline_keyboard: [[{ text: t(lang, "referralShareJoin"), url: link }]] };
    const id = `ref-${user.id}`.slice(0, 64);

    // Prefer the branded photo card; fall back to a rich text article if the
    // render fails (so the one-tap share never breaks).
    const card = await renderReferralCard({
      referrerName: user.firstName,
      giftMonths: env.REFERRAL_INVITEE_PREMIUM_MONTHS,
      lang,
    });
    const result = card
      ? {
          type: "photo" as const,
          id,
          photo_url: `${env.PUBLIC_BASE_URL}/v1/referral/card?u=${user.id}&sig=${cardSig(user.id)}`,
          thumbnail_url: `${env.PUBLIC_BASE_URL}/v1/referral/card?u=${user.id}&sig=${cardSig(user.id)}`,
          caption,
          reply_markup: keyboard,
        }
      : {
          type: "article" as const,
          id,
          title: "Gennety",
          description: caption,
          input_message_content: { message_text: `${caption}\n\n${link}` },
          reply_markup: keyboard,
        };

    try {
      const prepared = await api.savePreparedInlineMessage(
        auth.user.id,
        result as Parameters<typeof api.savePreparedInlineMessage>[1],
        { allow_user_chats: true, allow_group_chats: true, allow_channel_chats: true },
      );
      res.status(200).json({ ok: true, id: prepared.id });
    } catch (err) {
      console.warn("[referral] savePreparedInlineMessage failed", err);
      res.status(502).json({ error: "share-failed" });
    }
  });

  // PUBLIC signed image — Telegram fetches this to render the shared photo, so
  // it carries no initData. The HMAC ties the URL to a bot-minted share.
  router.get("/card", async (req: Request, res: Response): Promise<void> => {
    const u = String(req.query.u ?? "");
    const sig = String(req.query.sig ?? "");
    if (!u || !sig) {
      res.status(400).end();
      return;
    }
    const expected = cardSig(u);
    if (
      sig.length !== expected.length ||
      !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
    ) {
      res.status(403).end();
      return;
    }
    const user = await prisma.user.findUnique({
      where: { id: u },
      select: { firstName: true, language: true },
    });
    if (!user) {
      res.status(404).end();
      return;
    }
    const card = await renderReferralCard({
      referrerName: user.firstName,
      giftMonths: env.REFERRAL_INVITEE_PREMIUM_MONTHS,
      lang: (user.language ?? "en") as Language,
    });
    if (!card) {
      res.status(500).end();
      return;
    }
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.end(card);
  });

  return router;
}
