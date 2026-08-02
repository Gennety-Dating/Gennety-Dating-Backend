import { Router, type Request, type Response } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { env } from "../../config.js";
import { verifyTelegramIdToken } from "../../services/telegram-login.js";
import { findOrCreateUserByTelegramLogin } from "../mobile-user.js";
import { accessTokenTtlSeconds, createRefreshToken, signAccessToken } from "../jwt.js";
import { serializeUser } from "./serializers.js";

/**
 * POST /v1/auth/telegram — "Continue with Telegram" for the native app.
 *
 * The client runs Telegram's official iOS Login SDK, which hands control to
 * the installed Telegram app and returns a signed OpenID Connect ID token.
 * That token is the whole payload: we verify it against Telegram's public keys
 * (services/telegram-login.ts) and mint our own session on the account it
 * identifies.
 *
 * Two things this buys beyond a second login button. With the `phone` scope,
 * Telegram hands us an already-verified number — the same contact rail that
 * otherwise costs a Twilio SMS. And the token's subject IS `User.telegramId`,
 * so a user who has been talking to the bot lands in their existing profile
 * instead of starting over.
 */
export const telegramAuthRouter: Router = Router();

/** A login attempt is cheap for us and expensive to brute-force; cap anyway. */
const loginLimiter = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req): string => `tg-login:${ipKeyGenerator(req.ip ?? "") ?? "anon"}`,
  message: { error: "Too many login attempts, slow down." },
});

telegramAuthRouter.post(
  "/telegram",
  loginLimiter,
  async (req: Request, res: Response): Promise<void> => {
    if (!env.TELEGRAM_LOGIN_CLIENT_ID) {
      res.status(503).json({ error: "Telegram login is not configured" });
      return;
    }

    const idToken = typeof req.body?.idToken === "string" ? req.body.idToken.trim() : "";
    if (!idToken) {
      res.status(400).json({ error: "Missing idToken" });
      return;
    }

    const verified = await verifyTelegramIdToken(idToken);
    if (!verified.ok) {
      switch (verified.error) {
        case "not_configured":
          res.status(503).json({ error: "Telegram login is not configured" });
          return;
        case "keys_unavailable":
          // Our side could not reach Telegram's key set. Retrying works, so
          // this must not read as "your login is invalid".
          res.status(502).json({ error: "Could not verify with Telegram, try again" });
          return;
        case "invalid_token":
          res.status(401).json({ error: "Invalid Telegram token" });
          return;
      }
    }

    const resolved = await findOrCreateUserByTelegramLogin(verified.identity);
    if (resolved.kind === "conflict") {
      // The verified number and the Telegram identity point at two different
      // real accounts. Merging them is a human decision (same policy as the
      // Telegram-side `manual-merge`), so we refuse rather than pick one.
      res.status(409).json({
        error: "This number is already linked to another account",
        code: "account_conflict",
      });
      return;
    }

    const user = resolved.user;
    const accessToken = signAccessToken(user.id);
    const refreshToken = await createRefreshToken(user.id, req.headers["user-agent"] ?? null);

    res.json({
      accessToken,
      refreshToken,
      expiresIn: accessTokenTtlSeconds(),
      user: serializeUser(user),
    });
  },
);
