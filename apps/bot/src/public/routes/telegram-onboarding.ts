import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response } from "express";
import type { Api, RawApi } from "grammy";
import {
  prisma,
  type AiMemoryExportPreference,
  type Language,
} from "@gennety/db";
import {
  ALLOWED_EMAIL_DOMAINS,
  isUniversityEmail,
  SUPPORTED_LANGUAGES,
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
import { onboardingActivityPatch } from "../../workers/re-engagement-schedule.js";
import {
  buildHomeCityKey,
  saveHomeLocationForUser,
  validateHomeLocationPayload,
  type HomeLocationInput,
} from "../home-location.js";

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
  aiMemoryExportPreference: AiMemoryExportPreference;
  aiMemoryExportPreferenceAt: Date | null;
  termsAccepted: boolean;
  researchOptIn: boolean;
  isEmailVerified: boolean;
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
          onboardingStep: nextPreHandoffStep(user),
          ...onboardingActivityPatch(),
        },
        select: miniUserSelect,
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
  onboardingStep: true,
  aiMemoryExportPreference: true,
  aiMemoryExportPreferenceAt: true,
  termsAccepted: true,
  researchOptIn: true,
  isEmailVerified: true,
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

async function serializeState(user: MiniUser): Promise<TelegramOnboardingStateDto> {
  const emailVerification = user.isEmailVerified
    ? serializeOtpChallenge(null)
    : serializeOtpChallenge(await getOtpChallengeState(user.email));

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
      email: user.email,
      isEmailVerified: user.isEmailVerified,
      emailVerification,
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
    email: string | null;
    isEmailVerified: boolean;
    emailVerification: SerializedOtpChallenge;
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

function ensureReadyForLocation(
  user: MiniUser,
): "terms-required" | "language-required" | "email-required" | null {
  const emailGate = ensureReadyForEmail(user);
  if (emailGate) return emailGate;
  if (!user.isEmailVerified) return "email-required";
  return null;
}

function ensureReadyForAiMemoryChoice(
  user: MiniUser,
):
  | "terms-required"
  | "language-required"
  | "email-required"
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

interface CitySearchHit extends HomeLocationInput {
  label: string;
}

interface PlacesTextPlace {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  types?: string[];
  location?: { latitude?: number; longitude?: number };
  addressComponents?: Array<{
    longText?: string;
    shortText?: string;
    types?: string[];
  }>;
}

const FALLBACK_CITIES: CitySearchHit[] = [
  cityHit("Kyiv", "UA", 50.4501, 30.5234, "fallback:ua:kyiv"),
  cityHit("Lviv", "UA", 49.8397, 24.0297, "fallback:ua:lviv"),
  cityHit("Warsaw", "PL", 52.2297, 21.0122, "fallback:pl:warsaw"),
  cityHit("Berlin", "DE", 52.52, 13.405, "fallback:de:berlin"),
];

function cityHit(
  city: string,
  countryCode: string,
  latitude: number,
  longitude: number,
  placeId: string | null,
): CitySearchHit {
  return {
    label: `${city}, ${countryCode}`,
    homeCity: city,
    homeCountryCode: countryCode,
    homeCityKey: buildHomeCityKey(city, countryCode),
    homePlaceId: placeId,
    latitude,
    longitude,
  };
}

async function searchCities(query: string): Promise<CitySearchHit[]> {
  const apiKey = process.env.PLACES_API_KEY;
  if (!apiKey) return fallbackCitySearch(query);

  try {
    const response = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask":
          "places.id,places.displayName,places.formattedAddress,places.location,places.addressComponents,places.types",
      },
      body: JSON.stringify({
        textQuery: query,
        includedType: "locality",
        maxResultCount: 8,
      }),
    });
    if (!response.ok) return fallbackCitySearch(query);
    const json = (await response.json()) as { places?: PlacesTextPlace[] };
    const hits = (json.places ?? [])
      .map(cityHitFromPlace)
      .filter((hit): hit is CitySearchHit => hit !== null);
    return hits.length ? hits : fallbackCitySearch(query);
  } catch {
    return fallbackCitySearch(query);
  }
}

function fallbackCitySearch(query: string): CitySearchHit[] {
  const lower = query.toLowerCase();
  return FALLBACK_CITIES.filter((city) => city.homeCity.toLowerCase().includes(lower)).slice(0, 8);
}

function cityHitFromPlace(place: PlacesTextPlace): CitySearchHit | null {
  const lat = place.location?.latitude;
  const lng = place.location?.longitude;
  if (lat == null || lng == null) return null;

  const city =
    component(place, "locality", "longText") ??
    component(place, "administrative_area_level_1", "longText") ??
    place.displayName?.text ??
    "";
  const countryCode = component(place, "country", "shortText");
  if (!city || !countryCode) return null;
  return {
    ...cityHit(city, countryCode.toUpperCase(), lat, lng, place.id ?? null),
    label: place.formattedAddress ?? `${city}, ${countryCode.toUpperCase()}`,
  };
}

function component(
  place: PlacesTextPlace,
  type: string,
  field: "longText" | "shortText",
): string | null {
  for (const item of place.addressComponents ?? []) {
    if (item.types?.includes(type) && item[field]) return item[field]!;
  }
  return null;
}

interface GeocodeResult {
  place_id?: string;
  types?: string[];
  formatted_address?: string;
  geometry?: { location?: { lat?: number; lng?: number } };
  address_components?: Array<{
    long_name?: string;
    short_name?: string;
    types?: string[];
  }>;
}

async function resolveCityFromCoordinates(lat: number, lng: number): Promise<CitySearchHit> {
  const apiKey = process.env.PLACES_API_KEY;
  if (!apiKey) return FALLBACK_CITIES[0]!;

  try {
    const params = new URLSearchParams({
      latlng: `${lat},${lng}`,
      key: apiKey,
      result_type: "locality|administrative_area_level_1",
    });
    const response = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?${params.toString()}`);
    if (!response.ok) return FALLBACK_CITIES[0]!;
    const json = (await response.json()) as { results?: GeocodeResult[] };
    for (const result of json.results ?? []) {
      const hit = cityHitFromGeocode(result);
      if (hit) return hit;
    }
    return FALLBACK_CITIES[0]!;
  } catch {
    return FALLBACK_CITIES[0]!;
  }
}

function cityHitFromGeocode(result: GeocodeResult): CitySearchHit | null {
  const city =
    geocodeComponent(result, "locality", "long_name") ??
    geocodeComponent(result, "administrative_area_level_1", "long_name") ??
    "";
  const countryCode = geocodeComponent(result, "country", "short_name");
  const lat = result.geometry?.location?.lat;
  const lng = result.geometry?.location?.lng;
  if (!city || !countryCode || lat == null || lng == null) return null;
  return {
    ...cityHit(city, countryCode.toUpperCase(), lat, lng, result.place_id ?? null),
    label: result.formatted_address ?? `${city}, ${countryCode.toUpperCase()}`,
  };
}

function geocodeComponent(
  result: GeocodeResult,
  type: string,
  field: "long_name" | "short_name",
): string | null {
  for (const item of result.address_components ?? []) {
    if (item.types?.includes(type) && item[field]) return item[field]!;
  }
  return null;
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
