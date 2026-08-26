import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response } from "express";
import type { Api, RawApi } from "grammy";
import {
  prisma,
  type AiMemoryExportPreference,
  type Gender,
  type GenderPreference,
  type Language,
  type Theme,
} from "@gennety/db";
import {
  ALLOWED_EMAIL_DOMAINS,
  isUniversityEmail,
  LEGAL_DOCS_VERSION,
  MAX_AGE,
  MAX_HEIGHT_CM,
  MIN_AGE,
  MIN_HEIGHT_CM,
  SUPPORTED_LANGUAGES,
  t,
} from "@gennety/shared";
import { env } from "../../config.js";
import { DEMO_MODE_ENABLED } from "../../demo/config.js";
import { effectiveAiMemoryPreference } from "../../services/ai-memory-export.js";
import { validateInitData, type TelegramInitDataUser } from "../init-data.js";
import {
  createAndSendOtp,
  getOtpChallengeState,
  verifyOtp,
  type OtpChallengeState,
} from "../otp.js";
import { otpRequestLimiter, otpVerifyLimiter } from "../rate-limit.js";
import { runAgentTurn } from "../../services/onboarding-agent.js";
import {
  applyOnboardingFacts,
  type StructuredOnboardingFacts,
} from "../../services/onboarding-collector.js";
import { grantStudentBonusIfEligible } from "../../services/ticket-wallet.js";
import { onboardingActivityPatch } from "../../workers/re-engagement-schedule.js";
import {
  saveHomeLocationForUser,
  validateHomeLocationPayload,
} from "../home-location.js";
import {
  resolveMarketFromCoordinates,
  searchCities,
  supportedCityHits,
  type CitySearchHit,
} from "../city-search.js";
import { unresolvedTrackContactGate } from "../../services/contact-verification.js";
import { grantInviteePremium, parseReferrer, referralSourceFromParam } from "../../services/referral.js";
import {
  grantPromoRewardsForUser,
  parsePromoCode,
  promoSourceFromParam,
  resolvePromoCode,
} from "../../services/promo.js";

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
  firstName: string | null;
  age: number | null;
  gender: Gender | null;
  preference: GenderPreference | null;
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
  promoRedeemedAt: Date | null;
  messageHistory: unknown[];
  profile: {
    height: number | null;
    relationshipIntents: string[];
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
        // Art. 7(1): record WHAT was accepted, not just when.
        policyVersion: LEGAL_DOCS_VERSION,
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
      data: {
        registrationTrack: track,
        // Demo mode (DEMO_MODE.md): the general track's rail is a trusted
        // Telegram contact share, i.e. a real phone number. Asking an investor
        // for their number to look at a demo is both friction and a data
        // liability, so the rail is satisfied here instead and `User.phone`
        // stays null — the visitor still sees the fork and the phone screen,
        // the screen simply resolves itself on its next poll.
        ...(DEMO_MODE_ENABLED && track === "general"
          ? { phoneVerifiedAt: new Date() }
          : {}),
        ...onboardingActivityPatch(),
      },
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

      // Demo mode (DEMO_MODE.md): any well-formed code is accepted. The
      // visitor still types an address and still sees the OTP screen — what
      // they don't have to do is go and find a real inbox, which for a
      // university-domain address they usually don't have anyway. The demo
      // process also runs with OTP_LOG_TO_CONSOLE=true, so no mail is sent.
      if (!DEMO_MODE_ENABLED) {
        const result = await verifyOtp(user.email, code);
        if (!result.ok) {
          const status = result.reason === "mismatch" ? 401 : 400;
          res.status(status).json({ error: result.reason });
          return;
        }
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

    res.json({ ok: true, results: searchCities(q) });
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

    // Geolocation can only ever PRE-SELECT a launched market. Outside every
    // market the answer is an explicit `supported: false` with no city — the
    // Mini App then explains that Gennety hasn't launched there yet instead of
    // silently saving somewhere the user isn't.
    const resolution = resolveMarketFromCoordinates(lat, lng);
    res.json({ ok: true, supported: resolution.supported, city: resolution.city });
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

  /**
   * The five profile facts the Mini App collects on its own screens — name,
   * age, gender, who you're looking for, height (PRODUCT_SPEC §1.3).
   *
   * A partial patch, called once per screen rather than as one batch at the
   * end: closing the Mini App mid-way must not lose the answers already given,
   * and re-opening must resume on the first screen still unanswered.
   *
   * Writes go through the collector (`applyOnboardingFacts`), never straight to
   * Prisma, so `onboarding_progress` and the funnel telemetry stay consistent
   * with the chat path — and the chat then resumes on the first field this
   * never delivered. That fallback is the whole reason `/complete` does NOT
   * require these fields: a cached older bundle, the iOS rail and a legacy
   * mid-flight user all keep working unchanged.
   */
  router.post("/profile", async (req: Request, res: Response): Promise<void> => {
    const auth = authenticate(req);
    if (!auth.ok) {
      res.status(401).json(auth.body);
      return;
    }

    const user = await findOrCreateTelegramUser(auth.telegramId, req.query.source);
    // Same readiness the screens themselves sit behind: terms, language, a
    // verified contact rail, and a launched dating city.
    const gate = ensureReadyForAiMemoryChoice(user);
    if (gate) {
      res.status(409).json({ error: gate });
      return;
    }
    if (user.onboardingStep === "completed") {
      res.status(409).json({ error: "already-complete" });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const parsed = parseProfileBasicsPatch(body);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    if (Object.keys(parsed.facts).length === 0) {
      res.status(400).json({ error: "no-fields" });
      return;
    }

    // All-or-nothing: a rejected value writes nothing, so a client can never
    // half-save a screen and advance past it.
    const snapshot = await applyOnboardingFacts(auth.telegramId, parsed.facts);
    const rejection = snapshot.rejectedFields[0];
    if (rejection) {
      res.status(400).json({ error: rejection.reason, field: rejection.field });
      return;
    }

    const updated = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: miniUserSelect,
    });
    logTelegramOnboarding("profile-saved", updated, {
      fields: snapshot.acceptedFields,
      next: snapshot.currentQuestion,
    });
    res.json(await serializeState(updated));
  });

  router.post("/ai-memory", async (req: Request, res: Response): Promise<void> => {
    // AI-memory export kill switch: with the feature off the Mini App never
    // renders the choice screen, so a request here is a stale client. 404 the
    // route (same shape as the phone-rail gate) rather than persisting a
    // preference the flag would mask anyway.
    if (!env.AI_MEMORY_EXPORT_ENABLED) {
      res.status(404).json({ error: "ai-memory-export-disabled" });
      return;
    }
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

  // Promo welcome gift (PROMO_CODES_PRODUCT_SPEC.md): claim the promo-attributed
  // new user's one-time Date Ticket + Premium months, shown on the richer promo
  // wow screen (2nd-to-last, before AI-memory). Idempotent —
  // `grantPromoRewardsForUser` no-ops once redeemed / when not a valid promo
  // attribution / when the code is no longer redeemable, so a replayed tap can't
  // double-grant.
  router.post("/promo-gift", async (req: Request, res: Response): Promise<void> => {
    const auth = authenticate(req);
    if (!auth.ok) {
      res.status(401).json(auth.body);
      return;
    }

    const user = await findOrCreateTelegramUser(auth.telegramId, req.query.source);
    const gift = await grantPromoRewardsForUser(user.id);
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { ...onboardingActivityPatch() },
      select: miniUserSelect,
    });
    logTelegramOnboarding("promo-gift-claimed", updated, {
      applied: gift != null,
      code: gift?.code ?? null,
      tickets: gift?.ticketsApplied ?? 0,
      months: gift?.monthsApplied ?? 0,
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
    // Masked to `declined` while `AI_MEMORY_EXPORT_ENABLED` is off, so the
    // handoff no longer waits on a choice screen the client never shows.
    if (effectiveAiMemoryPreference(user.aiMemoryExportPreference) === "undecided") {
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
  // The five profile facts the Mini App collects on its own screens
  // (PRODUCT_SPEC §1.3). Mirrored back in `/state.profileBasics` so the client
  // resumes on the first unanswered screen instead of replaying the set.
  firstName: true,
  age: true,
  gender: true,
  preference: true,
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
  promoRedeemedAt: true,
  messageHistory: true,
  profile: {
    select: {
      height: true,
      relationshipIntents: true,
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

  const rawParam =
    typeof source === "string" && source.trim() ? source.trim().slice(0, 48) : null;
  const referral = rawParam
    ? /^promo_/i.test(rawParam)
      ? promoSourceFromParam(rawParam, "tg-mini")
      : referralSourceFromParam(rawParam, "tg-mini")
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

  // Promo welcome gift (PROMO_CODES_PRODUCT_SPEC.md): resolve the promo code
  // (only for promo-attributed users, so no extra DB read on the common path).
  // Takes precedence over the referral screen — a single `referralSource` value
  // is one or the other, and promo is the richer gift.
  const promoCode = env.PROMO_FEATURE_ENABLED ? parsePromoCode(user.referralSource) : null;
  const promoResolved = promoCode ? await resolvePromoCode(promoCode) : null;
  const promoGiftSeen = user.promoRedeemedAt != null;
  const invitedByPromo = promoCode != null && (promoResolved != null || promoGiftSeen);
  const promoTickets = promoResolved?.ticketReward ?? env.PROMO_DEFAULT_TICKETS;
  const promoMonths = promoResolved?.premiumMonths ?? env.PROMO_DEFAULT_PREMIUM_MONTHS;

  // Referral welcome gift (§Referral): show the wow screen when this user was
  // invited by a real referrer, the feature is on, and a gift month is offered.
  // Suppressed when a promo gift owns this user's attribution.
  const referrerId = parseReferrer(user.referralSource);
  const invitedByReferral =
    !invitedByPromo &&
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
      // AI-memory export kill switch (PRODUCT_SPEC §1.1). False → the Mini App
      // skips the choice screen entirely and goes straight to the handoff.
      aiMemoryExportEnabled: env.AI_MEMORY_EXPORT_ENABLED,
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
      // Promo welcome gift (PROMO_CODES_PRODUCT_SPEC.md): drives the richer
      // promo wow screen; precedence over referral.
      invitedByPromo,
      promoGiftSeen,
      promoCode,
      promoTickets,
      promoMonths,
      // Launched markets (packages/shared/src/markets.ts). The Mini App renders
      // them as one-tap options and never has to hardcode a city list, so a new
      // market goes live with the server rather than a bundle redeploy.
      supportedCities: supportedCityHits(),
      // The Mini App's own profile screens (PRODUCT_SPEC §1.3). The client
      // routes to the first `null` here, so server state — not DeviceStorage —
      // is what decides where a reopened session resumes, and a user who
      // already answered in chat skips the screens entirely.
      profileBasics: {
        firstName: user.firstName,
        age: user.age,
        gender: user.gender,
        preference: user.preference,
        height: user.profile?.height ?? null,
        relationshipIntents: user.profile?.relationshipIntents ?? [],
      },
      // Served rather than inlined in the bundle: `apps/webapp` deliberately
      // does not depend on `@gennety/shared`, and a bound that lives in two
      // places eventually disagrees with itself. Same precedent as
      // `supportedCities`.
      profileLimits: {
        minAge: MIN_AGE,
        maxAge: MAX_AGE,
        minHeightCm: MIN_HEIGHT_CM,
        maxHeightCm: MAX_HEIGHT_CM,
      },
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
    /** `AI_MEMORY_EXPORT_ENABLED` — false hides the AI-memory choice screen. */
    aiMemoryExportEnabled: boolean;
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
    // Promo-code welcome gift (PROMO_CODES_PRODUCT_SPEC.md). Drives the richer
    // promo wow screen (ticket + N months). Takes precedence over the referral
    // screen. Inert for non-promo users.
    invitedByPromo: boolean;
    promoGiftSeen: boolean;
    promoCode: string | null;
    promoTickets: number;
    promoMonths: number;
    /** Every city registration currently accepts (Kyiv-only at launch). */
    supportedCities: CitySearchHit[];
    /** The six facts the Mini App's own profile screens collect. */
    profileBasics: {
      firstName: string | null;
      age: number | null;
      gender: Gender | null;
      preference: GenderPreference | null;
      height: number | null;
      /** `spark` | `open` | `falling` | `longterm`; see `@gennety/shared`. */
      relationshipIntents: string[];
    };
    /** Server-owned bounds for the age slider and the height drum. */
    profileLimits: {
      minAge: number;
      maxAge: number;
      minHeightCm: number;
      maxHeightCm: number;
    };
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

/**
 * Shape-check the profile patch and map it onto the collector's canonical field
 * names. Only shape lives here — ranges, enum whitelists and name normalization
 * are `validateFactValue`'s job, so the Mini App, the chat and the iOS rail all
 * answer to one set of rules.
 */
function parseProfileBasicsPatch(
  body: Record<string, unknown>,
): { facts: StructuredOnboardingFacts } | { error: string } {
  const facts: StructuredOnboardingFacts = {};

  if (body.firstName !== undefined) {
    if (typeof body.firstName !== "string") return { error: "invalid-first-name" };
    facts.first_name = body.firstName;
  }
  if (body.age !== undefined) {
    if (typeof body.age !== "number" || !Number.isFinite(body.age)) {
      return { error: "invalid-age" };
    }
    facts.age = body.age;
  }
  if (body.gender !== undefined) {
    if (typeof body.gender !== "string") return { error: "invalid-gender" };
    facts.gender = body.gender;
  }
  if (body.preference !== undefined) {
    if (typeof body.preference !== "string") return { error: "invalid-preference" };
    facts.preference = body.preference;
  }
  if (body.height !== undefined) {
    if (typeof body.height !== "number" || !Number.isFinite(body.height)) {
      return { error: "invalid-height" };
    }
    facts.height = body.height;
  }
  // Multi-select, so the Mini App posts an ARRAY. Whitelisted downstream by
  // `validateFactValue`, which normalises it and rejects an empty result with
  // `invalid_relationship_intent` rather than writing an unanswered set
  // through — a screen that saves nothing must not read as answered.
  if (body.relationshipIntents !== undefined) {
    if (
      !Array.isArray(body.relationshipIntents) ||
      body.relationshipIntents.some((item) => typeof item !== "string")
    ) {
      return { error: "invalid-relationship-intent" };
    }
    facts.relationship_intent = body.relationshipIntents;
  }

  return { facts };
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
