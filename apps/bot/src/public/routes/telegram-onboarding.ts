import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response } from "express";
import type { Api, RawApi } from "grammy";
import { prisma, type Language } from "@gennety/db";
import {
  ALLOWED_EMAIL_DOMAINS,
  isUniversityEmail,
  SUPPORTED_LANGUAGES,
} from "@gennety/shared";
import { env } from "../../config.js";
import { validateInitData, type TelegramInitDataUser } from "../init-data.js";
import { createAndSendOtp, verifyOtp } from "../otp.js";
import { otpRequestLimiter, otpVerifyLimiter } from "../rate-limit.js";
import { runAgentTurn } from "../../services/onboarding-agent.js";
import { onboardingActivityPatch } from "../../workers/re-engagement-schedule.js";

const VALID_LANGUAGES = new Set<string>(SUPPORTED_LANGUAGES);
const FLOW_TOKEN_TTL_MS = 30 * 60 * 1000;
const DB_LOG_FINGERPRINT = createHash("sha256").update(env.DATABASE_URL).digest("hex").slice(0, 12);

type AuthOk = { ok: true; telegramUser: TelegramInitDataUser; telegramId: bigint };
type AuthErr = { ok: false; body: { error: string; reason?: string } };

type MiniUser = {
  id: string;
  telegramId: bigint;
  email: string | null;
  language: Language | null;
  onboardingStep: "consent" | "language" | "conversational" | "completed";
  termsAccepted: boolean;
  researchOptIn: boolean;
  isEmailVerified: boolean;
  messageHistory: unknown[];
};

export function createTelegramOnboardingRouter(api: Api<RawApi>): Router {
  const router = Router();

  router.get("/state", async (req: Request, res: Response): Promise<void> => {
    const auth = authenticate(req);
    if (!auth.ok) {
      res.status(401).json(auth.body);
      return;
    }

    const user = await findOrCreateTelegramUser(auth.telegramId, req.query.source);
    logTelegramOnboarding("state", user, { source: sanitizedSource(req.query.source) });
    res.json(serializeState(user));
  });

  router.post("/consent", async (req: Request, res: Response): Promise<void> => {
    const auth = authenticate(req);
    if (!auth.ok) {
      res.status(401).json(auth.body);
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.termsAccepted !== true) {
      res.status(400).json({ error: "terms-required" });
      return;
    }
    if (body.researchOptIn !== undefined && typeof body.researchOptIn !== "boolean") {
      res.status(400).json({ error: "invalid-research-opt-in" });
      return;
    }

    const current = await findOrCreateTelegramUser(auth.telegramId, req.query.source);
    const user = await prisma.user.update({
      where: { id: current.id },
      data: {
        hasConsented: true,
        consentedAt: new Date(),
        termsAccepted: true,
        termsAcceptedAt: new Date(),
        researchOptIn: Boolean(body.researchOptIn),
        ...(current.onboardingStep === "consent" ? { onboardingStep: "language" as const } : {}),
        ...onboardingActivityPatch(),
      },
      select: miniUserSelect,
    });

    logTelegramOnboarding("consent", user);
    res.json(serializeState(user));
  });

  router.post("/language", async (req: Request, res: Response): Promise<void> => {
    const auth = authenticate(req);
    if (!auth.ok) {
      res.status(401).json(auth.body);
      return;
    }

    const current = await findOrCreateTelegramUser(auth.telegramId, req.query.source);
    if (!current.termsAccepted) {
      res.status(409).json({ error: "terms-required" });
      return;
    }

    const language = typeof req.body?.language === "string" ? req.body.language : "";
    if (!VALID_LANGUAGES.has(language)) {
      res.status(400).json({ error: "invalid-language" });
      return;
    }

    const user = await prisma.user.update({
      where: { id: current.id },
      data: {
        language: language as Language,
        onboardingStep: nextPreHandoffStep(current),
        ...onboardingActivityPatch(),
      },
      select: miniUserSelect,
    });

    logTelegramOnboarding("language", user);
    res.json(serializeState(user));
  });

  router.post(
    "/email/request",
    otpRequestLimiter,
    async (req: Request, res: Response): Promise<void> => {
      const auth = authenticate(req);
      if (!auth.ok) {
        res.status(401).json(auth.body);
        return;
      }

      const user = await findOrCreateTelegramUser(auth.telegramId, req.query.source);
      const gate = ensureReadyForEmail(user);
      if (gate) {
        res.status(409).json({ error: gate });
        return;
      }

      const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
      if (!email || !isUniversityEmail(email)) {
        res.status(400).json({
          error: "invalid-email",
          allowedDomains: ALLOWED_EMAIL_DOMAINS,
        });
        return;
      }

      if (user.isEmailVerified && user.email === email) {
        res.json({ ok: true, alreadyVerified: true });
        return;
      }

      const linked = await prisma.user.findUnique({
        where: { email },
        select: { id: true, telegramId: true },
      });
      if (linked && linked.id !== user.id) {
        res.status(409).json({ error: "email-linked-to-other-account" });
        return;
      }

      await prisma.user.update({
        where: { id: user.id },
        data: {
          email,
          universityDomain: domainFromEmail(email),
          emailOtp: null,
          emailOtpExpiresAt: null,
          isEmailVerified: false,
          ...onboardingActivityPatch(),
        },
      });

      try {
        await createAndSendOtp(email);
      } catch (err) {
        console.error("[telegram-onboarding] failed to send OTP:", err);
        res.status(502).json({ error: "otp-send-failed" });
        return;
      }

      res.json({ ok: true, alreadyVerified: false });
    },
  );

  router.post(
    "/email/verify",
    otpVerifyLimiter,
    async (req: Request, res: Response): Promise<void> => {
      const auth = authenticate(req);
      if (!auth.ok) {
        res.status(401).json(auth.body);
        return;
      }

      const user = await findOrCreateTelegramUser(auth.telegramId, req.query.source);
      const gate = ensureReadyForEmail(user);
      if (gate) {
        res.status(409).json({ error: gate });
        return;
      }
      if (!user.email) {
        res.status(409).json({ error: "email-required" });
        return;
      }

      const code = typeof req.body?.code === "string" ? req.body.code.trim() : "";
      if (!/^\d{4,8}$/.test(code)) {
        res.status(400).json({ error: "invalid-code" });
        return;
      }

      const result = await verifyOtp(user.email, code);
      if (!result.ok) {
        const status = result.reason === "mismatch" ? 401 : 400;
        res.status(status).json({ error: result.reason });
        return;
      }

      const updated = await prisma.user.update({
        where: { id: user.id },
        data: {
          isEmailVerified: true,
          emailOtp: null,
          emailOtpExpiresAt: null,
          onboardingStep: nextPreHandoffStep(user),
          ...onboardingActivityPatch(),
        },
        select: miniUserSelect,
      });

      logTelegramOnboarding("email-verified", updated);
      res.json(serializeState(updated));
    },
  );

  router.post("/complete", async (req: Request, res: Response): Promise<void> => {
    const auth = authenticate(req);
    if (!auth.ok) {
      res.status(401).json(auth.body);
      return;
    }

    const user = await findOrCreateTelegramUser(auth.telegramId, req.query.source);
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (
      body.completedVisualIntro !== true ||
      !verifyOnboardingFlowToken(body.flowToken, auth.telegramId)
    ) {
      logTelegramOnboarding("complete-rejected", user, {
        reason: "visual-intro-required",
        hasCompletedVisualIntro: body.completedVisualIntro === true,
        hasFlowToken: typeof body.flowToken === "string",
      });
      res.status(409).json({ error: "visual-intro-required" });
      return;
    }

    logTelegramOnboarding("complete-request", user);
    if (!user.termsAccepted) {
      res.status(409).json({ error: "terms-required" });
      return;
    }
    if (!user.language) {
      res.status(409).json({ error: "language-required" });
      return;
    }
    if (!user.isEmailVerified) {
      res.status(409).json({ error: "email-required" });
      return;
    }

    if (user.onboardingStep === "completed") {
      await api.sendMessage(Number(user.telegramId), alreadyCompleteCopy(user.language));
      logTelegramOnboarding("complete-already-done", user);
      res.json({ ok: true, botTookOver: true, completed: true });
      return;
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { onboardingStep: "conversational", ...onboardingActivityPatch() },
    });

    const existingPrompt = lastAssistantMessage(user.messageHistory);
    const reply =
      existingPrompt ??
      (
        await runAgentTurn(
          user.telegramId,
          "[User completed the full-screen Telegram Mini App entry flow. " +
            "Continue onboarding in chat from the next required field. " +
            "Do not ask for email or OTP again because the email is already verified.]",
        )
      ).reply;

    await sendMarkdownSafe(api, Number(user.telegramId), reply);
    logTelegramOnboarding("complete-handoff", user);
    res.json({ ok: true, botTookOver: true, completed: false });
  });

  return router;
}

const miniUserSelect = {
  id: true,
  telegramId: true,
  email: true,
  language: true,
  onboardingStep: true,
  termsAccepted: true,
  researchOptIn: true,
  isEmailVerified: true,
  messageHistory: true,
} as const;

function authenticate(req: Request): AuthOk | AuthErr {
  const authHeader = req.header("authorization") ?? req.header("Authorization");
  if (!authHeader?.startsWith("tma ")) {
    return { ok: false, body: { error: "Missing tma initData" } };
  }
  const initData = authHeader.slice(4).trim();
  if (!initData) {
    return { ok: false, body: { error: "Empty initData" } };
  }

  const validation = validateInitData(initData, env.BOT_TOKEN);
  if (!validation.valid) {
    return { ok: false, body: { error: "Invalid initData", reason: validation.reason } };
  }
  return {
    ok: true,
    telegramUser: validation.user,
    telegramId: BigInt(validation.user.id),
  };
}

async function findOrCreateTelegramUser(
  telegramId: bigint,
  source: unknown,
): Promise<MiniUser> {
  const existing = await prisma.user.findUnique({
    where: { telegramId },
    select: miniUserSelect,
  });
  if (existing) return existing;

  const referral =
    typeof source === "string" && source.trim()
      ? `tg-mini:${source.trim().slice(0, 48)}`
      : null;

  return prisma.user.create({
    data: {
      telegramId,
      firstName: null,
      platform: "telegram",
      ...(referral ? { referralSource: referral } : {}),
    },
    select: miniUserSelect,
  });
}

function serializeState(user: MiniUser): TelegramOnboardingStateDto {
  return {
    ok: true,
    flowToken: issueOnboardingFlowToken(user.telegramId),
    user: {
      onboardingStep: user.onboardingStep,
      termsAccepted: user.termsAccepted,
      researchOptIn: user.researchOptIn,
      language: user.language,
      email: user.email,
      isEmailVerified: user.isEmailVerified,
      completed: user.onboardingStep === "completed",
    },
  };
}

interface TelegramOnboardingStateDto {
  ok: true;
  flowToken: string;
  user: {
    onboardingStep: MiniUser["onboardingStep"];
    termsAccepted: boolean;
    researchOptIn: boolean;
    language: Language | null;
    email: string | null;
    isEmailVerified: boolean;
    completed: boolean;
  };
}

function nextPreHandoffStep(user: MiniUser): MiniUser["onboardingStep"] {
  if (user.onboardingStep === "completed" || user.onboardingStep === "conversational") {
    return user.onboardingStep;
  }
  return "language";
}

function ensureReadyForEmail(user: MiniUser): "terms-required" | "language-required" | null {
  if (!user.termsAccepted) return "terms-required";
  if (!user.language) return "language-required";
  return null;
}

function domainFromEmail(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1).toLowerCase();
}

function alreadyCompleteCopy(language: Language | null): string {
  if (language === "ru") return "Онбординг Gennety уже завершён.";
  if (language === "uk") return "Онбординг Gennety вже завершено.";
  return "Gennety onboarding is already complete.";
}

function issueOnboardingFlowToken(telegramId: bigint): string {
  const issuedAt = Date.now().toString(36);
  const payload = `${telegramId.toString()}.${issuedAt}`;
  const signature = createHmac("sha256", env.BOT_TOKEN).update(payload).digest("base64url");
  return `${issuedAt}.${signature}`;
}

function verifyOnboardingFlowToken(token: unknown, telegramId: bigint): boolean {
  if (typeof token !== "string") return false;
  const [issuedAt, signature, extra] = token.split(".");
  if (!issuedAt || !signature || extra !== undefined) return false;

  const issuedAtMs = Number.parseInt(issuedAt, 36);
  if (!Number.isFinite(issuedAtMs)) return false;

  const ageMs = Date.now() - issuedAtMs;
  if (ageMs < -60_000 || ageMs > FLOW_TOKEN_TTL_MS) return false;

  const payload = `${telegramId.toString()}.${issuedAt}`;
  const expected = createHmac("sha256", env.BOT_TOKEN).update(payload).digest("base64url");
  const providedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return providedBuffer.length === expectedBuffer.length && timingSafeEqual(providedBuffer, expectedBuffer);
}

function sanitizedSource(source: unknown): string | null {
  return typeof source === "string" && source.trim() ? source.trim().slice(0, 48) : null;
}

function logTelegramOnboarding(
  event: string,
  user: MiniUser,
  extra: Record<string, unknown> = {},
): void {
  console.info("[telegram-onboarding]", event, {
    db: DB_LOG_FINGERPRINT,
    userId: user.id.slice(0, 8),
    telegramHash: createHash("sha256").update(user.telegramId.toString()).digest("hex").slice(0, 8),
    step: user.onboardingStep,
    termsAccepted: user.termsAccepted,
    languageSet: Boolean(user.language),
    emailVerified: user.isEmailVerified,
    ...extra,
  });
}

function lastAssistantMessage(history: unknown[]): string | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i] as { role?: string; content?: unknown } | null;
    if (msg?.role === "assistant" && typeof msg.content === "string" && msg.content.trim()) {
      return msg.content;
    }
  }
  return null;
}

async function sendMarkdownSafe(api: Api<RawApi>, chatId: number, text: string): Promise<void> {
  try {
    await api.sendMessage(chatId, text, { parse_mode: "Markdown" });
  } catch {
    await api.sendMessage(chatId, text.replace(/[*_`[\]]/g, ""));
  }
}
