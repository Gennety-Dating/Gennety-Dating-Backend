import { createHmac, timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { prisma } from "@gennety/db";
import { t, type Language } from "@gennety/shared";
import { env } from "../../config.js";
import { validateInitData } from "../init-data.js";
import { buildReferralLink, buildReferralStateView } from "../../services/referral.js";
import { referralCardImage } from "../../services/referral-card/index.js";

/**
 * Referral Mini App endpoints (§Referral). TMA-authed (`Authorization: tma
 * <initData>`) like the ticket / premium Mini Apps, except `GET /card` which is
 * a PUBLIC signed image endpoint (Telegram fetches it when rendering the shared
 * photo, so it can't carry initData). Mounted at `/v1/referral`, feature-gated.
 *
 *   GET  /v1/referral/state          — ladder + progress + $ value + invite link
 *   POST /v1/referral/share-message  — mint a one-tap savePreparedInlineMessage
 *   GET  /v1/referral/card?u=&v=&sig= — serve the invite card JPEG (public, HMAC)
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

/**
 * Short HMAC over the referrer id so only bot-minted card URLs render.
 *
 * The content version is part of the signed payload, so a card whose bytes
 * changed mints a genuinely different URL without weakening the binding. That
 * matters because Telegram caches downloaded media **by URL**: a stable URL
 * meant a card it once fetched badly stayed bad for that referrer forever.
 * Omitting the version reproduces the pre-versioning signature, which is still
 * honoured for shares prepared before this existed.
 */
function cardSig(referrerId: string, version?: string): string {
  const payload = version
    ? `referral-card:${referrerId}:${version}`
    : `referral-card:${referrerId}`;
  return createHmac("sha256", env.BOT_TOKEN).update(payload).digest("hex").slice(0, 24);
}

/** Constant-time signature compare that tolerates a wrong-length input. */
function sigMatches(given: string, expected: string): boolean {
  return (
    given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected))
  );
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
    // render fails (so the one-tap share never breaks). Rendering here also
    // WARMS the cache the public /card endpoint reads, so Telegram's own fetch
    // of that URL is a memory read rather than a render it has to wait out —
    // the share is only offered as a photo once the bytes actually exist.
    const card = await referralCardImage({
      referrerName: user.firstName,
      giftMonths: env.REFERRAL_INVITEE_PREMIUM_MONTHS,
      lang,
    });
    const cardUrl = card
      ? `${env.PUBLIC_BASE_URL}/v1/referral/card?u=${user.id}&v=${card.version}&sig=${cardSig(user.id, card.version)}`
      : "";
    const result = card
      ? {
          type: "photo" as const,
          id,
          photo_url: cardUrl,
          thumbnail_url: cardUrl,
          // Stated up front so Telegram never has to probe the file to size the
          // bubble, and the client can lay it out before the image lands.
          photo_width: card.width,
          photo_height: card.height,
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
    const version = String(req.query.v ?? "");
    if (!u || !sig) {
      res.status(400).end();
      return;
    }
    if (!sigMatches(sig, cardSig(u, version || undefined))) {
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
    // Normally a cache hit warmed by /share-message, so nothing is rendered on
    // the request path Telegram is timing.
    const card = await referralCardImage({
      referrerName: user.firstName,
      giftMonths: env.REFERRAL_INVITEE_PREMIUM_MONTHS,
      lang: (user.language ?? "en") as Language,
    });
    if (!card) {
      res.status(500).end();
      return;
    }
    res.setHeader("Content-Type", "image/jpeg");
    // A versioned URL's bytes never change, so it can be cached hard. The
    // legacy unversioned URL can (a rename re-renders it), so it only gets a
    // plain max-age.
    res.setHeader(
      "Cache-Control",
      version ? "public, max-age=86400, immutable" : "public, max-age=3600",
    );
    // Declared explicitly: this endpoint's failure mode was a body that arrived
    // half-finished, and a stated length is what lets the client tell a
    // truncated download from a complete one instead of decoding what it got.
    res.setHeader("Content-Length", String(card.jpeg.length));
    res.end(card.jpeg);
  });

  return router;
}
