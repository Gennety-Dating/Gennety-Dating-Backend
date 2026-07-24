import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response } from "express";
import type { Api, RawApi } from "grammy";
import {
  prisma,
  type AiMemoryExportPreference,
  type Language,
  type Theme,
} from "@gennety/db";
import {
  ALLOWED_EMAIL_DOMAINS,
  isUniversityEmail,
  SUPPORTED_LANGUAGES,
  t,
} from "@gennety/shared";
import { env } from "../../config.js";
import { validateInitData, type TelegramInitDataUser } from "../init-data.js";
import {
  createAndSendOtp,
  getOtpChallengeState,
  verifyOtp,
  type OtpChallengeState,
} from "../otp.js";
import { otpRequestLimiter, otpVerifyLimiter } from "../rate-limit.js";
import { runAgentTurn } from "../../services/onboarding-agent.js";
import { grantStudentBonusIfEligible } from "../../services/ticket-wallet.js";
import { onboardingActivityPatch } from "../../workers/re-engagement-schedule.js";
import {
  saveHomeLocationForUser,
  validateHomeLocationPayload,
} from "../home-location.js";
import { resolveCityFromCoordinates, searchCities } from "../city-search.js";
import { unresolvedTrackContactGate } from "../../services/contact-verification.js";
import { grantInviteePremium, parseReferrer, referralSourceFromParam } from "../../services/referral.js";

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
  theme: Theme;
  themeChosenAt: Date | null;
  onboardingStep: "consent" | "language" | "conversational" | "completed";
  aiMemoryExportPreference: AiMemoryExportPreference;
  aiMemoryExportPreferenceAt: Date | null;
  termsAccepted: boolean;
  researchOptIn: boolean;
  isEmailVerified: boolean;
  phone: string | null;
  phoneVerifiedAt: Date | null;
  registrationTrack: string | null;
  referralSource: string | null;
  referralInviteePremiumAt: Date | null;
  messageHistory: unknown[];
  profile: {
    homeCity: string | null;
    homeCountryCode: string | null;
    homeCityKey: string | null;
    homePlaceId: string | null;
    latitude: number | null;
    longitude: number | null;
    locationUpdatedAt: Date | null;
  } | null;
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
    res.json(await serializeState(user));
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
    res.json(await serializeState(user));
  });

  router.post("/language", async (req: Request, res: Response): Promise<void> => {
    const auth = authenticate(req);
    if (!auth.ok) {
      res.status(401).json(auth.body);
      return;
    }

    const current = await findOrCreateTelegramUser(auth.telegramId, req.query.source);
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
    res.json(await serializeState(user));
  });

  // Registration v2: persist the sign-up fork choice. Re-choosing is allowed
  // while onboarding is incomplete (the user can go back from either gate);
  // the /complete contact gate reads the FINAL track, so switching mid-way
  // can never bypass verification.
  router.post("/track", async (req: Request, res: Response): Promise<void> => {
    const auth = authenticate(req);
    if (!auth.ok) {
      res.status(401).json(auth.body);
      return;
    }
    if (!env.PHONE_AUTH_ENABLED) {
      res.status(404).json({ error: "phone-auth-disabled" });
      return;
    }

    const track = req.body?.track;
    if (track !== "student" && track !== "general") {
      res.status(400).json({ error: "invalid-track" });
      return;
    }

    const current = await findOrCreateTelegramUser(auth.telegramId, req.query.source);
    const gate = ensureReadyForEmail(current);
    if (gate) {
      res.status(409).json({ error: gate });
      return;
    }
    if (current.onboardingStep === "completed") {
      res.status(409).json({ error: "already-complete" });
      return;
    }

    const user = await prisma.user.update({
      where: { id: current.id },
      data: { registrationTrack: track, ...onboardingActivityPatch() },
      select: miniUserSelect,
    });

    logTelegramOnboarding("track", user, { track });
    res.json(await serializeState(user));
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

      const existingChallenge = await getOtpChallengeState(email);
      if (
        existingChallenge.status === "pending" &&
        existingChallenge.resendAvailableAt &&
        existingChallenge.resendAvailableAt > new Date()
      ) {
        res.status(429).json({
          error: "otp-cooldown",
          emailVerification: serializeOtpChallenge(existingChallenge),
        });
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

      let challenge: OtpChallengeState;
      try {
        challenge = await createAndSendOtp(email);
      } catch (err) {
        console.error("[telegram-onboarding] failed to send OTP:", err);
        res.status(502).json({ error: "otp-send-failed" });
        return;
      }

      res.json({
        ok: true,
        alreadyVerified: false,
        emailVerification: serializeOtpChallenge(challenge),
      });
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
          // Registration v2: a verified university email IS the student track.
          registrationTrack: "student",
          onboardingStep: nextPreHandoffStep(user),
          ...onboardingActivityPatch(),
        },
        select: miniUserSelect,
      });

      // Registration v2 student loyalty: +2 free Date Tickets, exactly once
      // (idempotent ledger claim; no-op while TICKET_FEATURE_ENABLED is off).
      // Fire-and-forget with the celebratory DM — a wallet hiccup must never
      // block the OTP response.
      void grantStudentBonusIfEligible(updated.id)
        .then(async (reward) => {
          if (!reward.granted || !updated.language) return;
          await api.sendMessage(
            Number(updated.telegramId),
            t(updated.language, "ticketRewardStudent", { balance: reward.balance }),
            { parse_mode: "Markdown" },
          );
        })
        .catch((err) => {
          console.warn("[student-bonus] grant/DM failed:", (err as Error).message);
        });

      logTelegramOnboarding("email-verified", updated);
      res.json(await serializeState(updated));
    },
  );

  router.get("/city/search", async (req: Request, res: Response): Promise<void> => {
    const auth = authenticate(req);
    if (!auth.ok) {
      res.status(401).json(auth.body);
      return;
    }

    const user = await findOrCreateTelegramUser(auth.telegramId, req.query.source);
    const gate = ensureReadyForLocation(user);
    if (gate) {
      res.status(409).json({ error: gate });
      return;
    }

    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (q.length < 2) {
      res.json({ ok: true, results: [] });
      return;
    }

    const results = await searchCities(q);
    res.json({ ok: true, results });
  });

  router.post("/city/resolve", async (req: Request, res: Response): Promise<void> => {
    const auth = authenticate(req);
    if (!auth.ok) {
      res.status(401).json(auth.body);
      return;
    }

    const user = await findOrCreateTelegramUser(auth.telegramId, req.query.source);
    const gate = ensureReadyForLocation(user);
    if (gate) {
      res.status(409).json({ error: gate });
      return;
    }

    const lat = typeof req.body?.latitude === "number" ? req.body.latitude : null;
    const lng = typeof req.body?.longitude === "number" ? req.body.longitude : null;
    if (
      lat === null ||
      lng === null ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      Math.abs(lat) > 90 ||
      Math.abs(lng) > 180
    ) {
      res.status(400).json({ error: "invalid-coordinates" });
      return;
    }

    const city = await resolveCityFromCoordinates(lat, lng);
    res.json({ ok: true, city });
  });

  router.post("/city/select", async (req: Request, res: Response): Promise<void> => {
    const auth = authenticate(req);
    if (!auth.ok) {
      res.status(401).json(auth.body);
      return;
    }

    const user = await findOrCreateTelegramUser(auth.telegramId, req.query.source);
    const gate = ensureReadyForLocation(user);
    if (gate) {
      res.status(409).json({ error: gate });
      return;
    }

    const validation = validateHomeLocationPayload((req.body ?? {}) as Record<string, unknown>);
    if (!validation.ok) {
      res.status(400).json({ error: validation.error });
      return;
    }

    await saveHomeLocationForUser(user.id, validation.data);
    const updated = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: miniUserSelect,
    });

    logTelegramOnboarding("city-selected", updated, {
      homeCityKey: validation.data.homeCityKey,
    });
    res.json(await serializeState(updated));
  });

  router.post("/ai-memory", async (req: Request, res: Response): Promise<void> => {
    const auth = authenticate(req);
    if (!auth.ok) {
      res.status(401).json(auth.body);
      return;
    }

    const user = await findOrCreateTelegramUser(auth.telegramId, req.query.source);
    const gate = ensureReadyForAiMemoryChoice(user);
    if (gate) {
      res.status(409).json({ error: gate });
      return;
    }

    const preference = req.body?.preference;
    if (preference !== "accepted" && preference !== "declined") {
      res.status(400).json({ error: "invalid-ai-memory-preference" });
      return;
    }

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: {
        aiMemoryExportPreference: preference,
        aiMemoryExportPreferenceAt: new Date(),
        ...onboardingActivityPatch(),
      },
      select: miniUserSelect,
    });

    logTelegramOnboarding("ai-memory-selected", updated, { preference });
    res.json(await serializeState(updated));
  });

  // Theme picker (onboarding step after the city gate; also reused by the
  // Settings "Change theme" flow). Records the explicit choice + stamps
  // `themeChosenAt` so the onboarding picker shows exactly once.
  router.post("/theme", async (req: Request, res: Response): Promise<void> => {
    const auth = authenticate(req);
    if (!auth.ok) {
      res.status(401).json(auth.body);
      return;
    }

    const theme = req.body?.theme;
    if (theme !== "light" && theme !== "dark") {
      res.status(400).json({ error: "invalid-theme" });
      return;
    }

    const user = await findOrCreateTelegramUser(auth.telegramId, req.query.source);
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: {
        theme,
        themeChosenAt: new Date(),
        ...onboardingActivityPatch(),
      },
      select: miniUserSelect,
    });

    logTelegramOnboarding("theme-selected", updated, { theme });
    res.json(await serializeState(updated));
  });

  // Referral welcome gift (§Referral): claim the invitee's one-time Premium
  // month, shown on the onboarding wow screen (2nd-to-last, before AI-memory).
  // Idempotent — `grantInviteePremium` is a no-op once the marker is set or when
  // the user wasn't genuinely invited, so a replayed tap can't double-grant.
  router.post("/referral-gift", async (req: Request, res: Response): Promise<void> => {
    const auth = authenticate(req);
    if (!auth.ok) {
      res.status(401).json(auth.body);
      return;
    }

    const user = await findOrCreateTelegramUser(auth.telegramId, req.query.source);
    const referrerId = parseReferrer(user.referralSource);
    if (!env.REFERRAL_FEATURE_ENABLED || !referrerId || referrerId === user.id) {
      // Not a valid invitee — return current state so the client just advances.
      res.json(await serializeState(user));
      return;
    }

    const gift = await grantInviteePremium(user.id);
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { ...onboardingActivityPatch() },
      select: miniUserSelect,
    });
    logTelegramOnboarding("referral-gift-claimed", updated, {
      applied: gift.applied,
      months: gift.months,
    });
    res.json(await serializeState(updated));
  });

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
    const contactGate = unresolvedContactGate(user);
    if (contactGate) {
      res.status(409).json({ error: contactGate });
      return;
    }
    if (!hasHomeLocation(user)) {
      res.status(409).json({ error: "location-required" });
      return;
    }
    if (user.aiMemoryExportPreference === "undecided") {
      res.status(409).json({ error: "ai-memory-preference-required" });
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
          { kind: "resume" },
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
  theme: true,
  themeChosenAt: true,
  onboardingStep: true,
  aiMemoryExportPreference: true,
  aiMemoryExportPreferenceAt: true,
  termsAccepted: true,
  researchOptIn: true,
  isEmailVerified: true,
  phone: true,
  phoneVerifiedAt: true,
  registrationTrack: true,
  referralSource: true,
  referralInviteePremiumAt: true,
  messageHistory: true,
  profile: {
    select: {
      homeCity: true,
      homeCountryCode: true,
      homeCityKey: true,
      homePlaceId: true,
      latitude: true,
      longitude: true,
      locationUpdatedAt: true,
    },
  },
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
      ? referralSourceFromParam(source.trim().slice(0, 48), "tg-mini")
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

async function serializeState(user: MiniUser): Promise<TelegramOnboardingStateDto> {
  const emailVerification = user.isEmailVerified
    ? serializeOtpChallenge(null)
    : serializeOtpChallenge(await getOtpChallengeState(user.email));

  // Referral welcome gift (§Referral): show the wow screen when this user was
  // invited by a real referrer, the feature is on, and a gift month is offered.
  const referrerId = parseReferrer(user.referralSource);
  const invitedByReferral =
    env.REFERRAL_FEATURE_ENABLED &&
    env.REFERRAL_INVITEE_PREMIUM_MONTHS > 0 &&
    referrerId != null &&
    referrerId !== user.id;
  const referralGiftSeen = user.referralInviteePremiumAt != null;
  let referrerFirstName: string | null = null;
  if (invitedByReferral && !referralGiftSeen && referrerId) {
    const referrer = await prisma.user.findUnique({
      where: { id: referrerId },
      select: { firstName: true },
    });
    referrerFirstName = referrer?.firstName ?? null;
  }

  return {
    ok: true,
    flowToken: issueOnboardingFlowToken(user.telegramId),
    user: {
      onboardingStep: user.onboardingStep,
      aiMemoryExportPreference: user.aiMemoryExportPreference,
      aiMemoryExportPreferenceAt: user.aiMemoryExportPreferenceAt?.toISOString() ?? null,
      termsAccepted: user.termsAccepted,
      researchOptIn: user.researchOptIn,
      language: user.language,
      theme: user.theme,
      themeChosen: user.themeChosenAt != null,
      email: user.email,
      isEmailVerified: user.isEmailVerified,
      emailVerification,
      isPhoneVerified: user.phoneVerifiedAt != null,
      phone: user.phone,
      registrationTrack: user.registrationTrack,
      phoneAuthEnabled: env.PHONE_AUTH_ENABLED,
      // Referral welcome gift (§Referral): drives the onboarding wow screen.
      invitedByReferral,
      referralGiftSeen,
      referrerFirstName,
      referralGiftMonths: env.REFERRAL_INVITEE_PREMIUM_MONTHS,
      homeLocation: user.profile?.homeCityKey
        ? {
            homeCity: user.profile.homeCity,
            homeCountryCode: user.profile.homeCountryCode,
            homeCityKey: user.profile.homeCityKey,
            homePlaceId: user.profile.homePlaceId,
            latitude: user.profile.latitude,
            longitude: user.profile.longitude,
            locationUpdatedAt: user.profile.locationUpdatedAt
              ? user.profile.locationUpdatedAt.toISOString()
              : null,
          }
        : null,
      completed: user.onboardingStep === "completed",
    },
  };
}

interface TelegramOnboardingStateDto {
  ok: true;
  flowToken: string;
  user: {
    onboardingStep: MiniUser["onboardingStep"];
    aiMemoryExportPreference: MiniUser["aiMemoryExportPreference"];
    aiMemoryExportPreferenceAt: string | null;
    termsAccepted: boolean;
    researchOptIn: boolean;
    language: Language | null;
    theme: Theme;
    /** True once the user has explicitly picked a theme (onboarding/Settings). */
    themeChosen: boolean;
    email: string | null;
    isEmailVerified: boolean;
    emailVerification: SerializedOtpChallenge;
    // Registration v2 (general track). Inert until the fork ships: legacy
    // clients ignore the extra fields.
    isPhoneVerified: boolean;
    phone: string | null;
    registrationTrack: string | null;
    /// Server flag mirror: the Mini App renders the sign-up fork only when
    /// the phone rail is actually live (env-controlled, no rebuild needed).
    phoneAuthEnabled: boolean;
    // Referral welcome gift (§Referral). Inert for non-referred users.
    invitedByReferral: boolean;
    referralGiftSeen: boolean;
    referrerFirstName: string | null;
    referralGiftMonths: number;
    homeLocation: {
      homeCity: string | null;
      homeCountryCode: string | null;
      homeCityKey: string;
      homePlaceId: string | null;
      latitude: number | null;
      longitude: number | null;
      locationUpdatedAt: string | null;
    } | null;
    completed: boolean;
  };
}

type SerializedOtpChallenge = {
  status: OtpChallengeState["status"];
  expiresAt: string | null;
  resendAvailableAt: string | null;
  attemptsRemaining: number;
};

function serializeOtpChallenge(challenge: OtpChallengeState | null): SerializedOtpChallenge {
  return {
    status: challenge?.status ?? "none",
    expiresAt: challenge?.expiresAt?.toISOString() ?? null,
    resendAvailableAt: challenge?.resendAvailableAt?.toISOString() ?? null,
    attemptsRemaining: challenge?.attemptsRemaining ?? 0,
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

function unresolvedContactGate(user: MiniUser): "email-required" | "phone-required" | null {
  return unresolvedTrackContactGate(user);
}

function ensureReadyForLocation(
  user: MiniUser,
): "terms-required" | "language-required" | "email-required" | "phone-required" | null {
  const emailGate = ensureReadyForEmail(user);
  if (emailGate) return emailGate;
  return unresolvedContactGate(user);
}

function ensureReadyForAiMemoryChoice(
  user: MiniUser,
):
  | "terms-required"
  | "language-required"
  | "email-required"
  | "phone-required"
  | "location-required"
  | null {
  const locationGate = ensureReadyForLocation(user);
  if (locationGate) return locationGate;
  if (!hasHomeLocation(user)) return "location-required";
  return null;
}

function hasHomeLocation(user: MiniUser): boolean {
  return Boolean(
    user.profile?.homeCityKey &&
      user.profile.latitude !== null &&
      user.profile.longitude !== null,
  );
}

function domainFromEmail(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1).toLowerCase();
}

function alreadyCompleteCopy(language: Language | null): string {
  if (language === "ru") return "Онбординг Gennety уже завершён.";
  if (language === "uk") return "Онбординг Gennety вже завершено.";
  if (language === "de") return "Das Gennety-Onboarding ist bereits abgeschlossen.";
  if (language === "pl") return "Onboarding Gennety jest już ukończony.";
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
