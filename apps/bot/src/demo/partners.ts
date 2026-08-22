import { prisma, type Gender, type GenderPreference, type Prisma } from "@gennety/db";
import { DEFAULT_MARKET, cityKeyToTimeZone } from "@gennety/shared";
import { refreshUserEmbedding } from "../workers/embedding-refresh.js";
import { getBalance, grantTickets } from "../services/ticket-wallet.js";

/**
 * The puppet on the other side of every demo match.
 *
 * Two fixed profiles — one man, one woman — picked by what the visitor said
 * they are looking for. They are ordinary `User` + `Profile` rows, not a
 * special case anywhere in the product: the pitch generator, the calendar, the
 * venue selector and the date lifecycle all read them exactly as they read a
 * real person. That is the whole point of demo mode.
 *
 * Two properties make them safe:
 *
 *   - `platform: "mobile"` with a **negative** `telegramId`. This is the
 *     existing mechanism for a participant the bot cannot DM (ARCHITECTURE.md →
 *     `users`), so every Telegram-only path already skips them. The puppet
 *     never receives a message and never needs a chat of its own.
 *   - They live only in the demo database. Production has no rows like this and
 *     no code that would create them — `seedDemoPartners()` is called from the
 *     demo driver, which does not start unless `DEMO_MODE_ENABLED`.
 */

/**
 * Fixed synthetic ids. Mobile users get a random negative id in `[-2^48, -1]`
 * (`public/mobile-user.ts`), so these two are formally in the same space; the
 * chance of a collision is ~2^-47 per row and the demo database has no mobile
 * users at all. Fixed rather than random so re-seeding is idempotent and the
 * rows are recognisable at a glance in the database.
 */
export const DEMO_PARTNER_MALE_TELEGRAM_ID = -777_000_001n;
export const DEMO_PARTNER_FEMALE_TELEGRAM_ID = -777_000_002n;

export interface DemoPartnerDefinition {
  telegramId: bigint;
  firstName: string;
  age: number;
  gender: Gender;
  preference: GenderPreference;
  height: number;
  hobbies: string[];
  partnerPreferences: string;
  /**
   * The dominant matching input (`V_explicit`, weight 0.65) and what the pitch
   * generator actually reads. Written as the fallback summary a declined-AI-memory
   * user would get: open-ended psychological prose, no demographics — those are
   * `V_research`'s job and duplicating them here would double-count.
   */
  psychologicalSummary: string;
  fridayVibeText: string;
  vibeFocusText: string;
  energyAxis: number;
  orientationAxis: number;
  anchorTags: string[];
  /**
   * Seeded rather than computed: the vision Elo pass runs inside the
   * verification pipeline, which the puppet never goes through. 520 sits just
   * above the 500 default so `V_league` reads as an ordinary same-tier pairing.
   */
  eloScore: number;
}

/**
 * Everything a demo visitor sees about their "match" is in this block. Change a
 * name, an age or a bio here and re-run `pnpm demo:seed` — nothing else in the
 * codebase encodes who these two people are.
 */
export const DEMO_PARTNERS: readonly DemoPartnerDefinition[] = [
  {
    telegramId: DEMO_PARTNER_MALE_TELEGRAM_ID,
    firstName: "Артём",
    age: 29,
    gender: "male",
    preference: "women",
    height: 183,
    hobbies: ["архитектура", "бег", "виниловые пластинки", "готовка"],
    partnerPreferences:
      "Кто-то, с кем интересно молчать и интересно спорить. Ценю прямоту и " +
      "чувство юмора, которое не приходится объяснять.",
    psychologicalSummary:
      "Спокойный, наблюдательный, с сухим чувством юмора. Работает архитектором " +
      "и мыслит пространствами: замечает, как устроено место и как оно меняет " +
      "людей внутри. Не заполняет паузы разговором ради разговора — если " +
      "говорит, то по делу или чтобы пошутить. Сильно вовлекается в то, что " +
      "выбрал: может месяц разбираться в одном рецепте или одном альбоме. " +
      "Инициативу берёт мягко, без напора, но решение принимает сам. Плохо " +
      "переносит суету и показное; хорошо — длинные разговоры вдвоём и вещи, " +
      "сделанные руками. Ищет не развлечение, а человека, рядом с которым не " +
      "нужно быть в тонусе.",
    fridayVibeText:
      "Ужин, который готовим сами, потом гулять по городу без маршрута и " +
      "разговаривать до ночи. Без толпы.",
    vibeFocusText: "Кто рядом. Место — это просто повод.",
    energyAxis: -0.35,
    orientationAxis: 0.55,
    anchorTags: ["архитектура", "кулинария", "музыка", "город"],
    eloScore: 520,
  },
  {
    telegramId: DEMO_PARTNER_FEMALE_TELEGRAM_ID,
    firstName: "Ева",
    age: 25,
    gender: "female",
    preference: "men",
    height: 169,
    hobbies: ["иллюстрация", "йога", "керамика", "документальное кино"],
    partnerPreferences:
      "Хочу человека со своим делом и своим мнением. Чтобы было любопытно " +
      "слушать и не страшно не соглашаться.",
    psychologicalSummary:
      "Тёплая и внимательная, но с очень чётким внутренним стержнем. Рисует " +
      "иллюстрации на заказ, поэтому привыкла замечать детали, которые другие " +
      "проскакивают — и в картинках, и в людях. Легко сходится с новыми людьми, " +
      "но близко подпускает медленно и осознанно. Не любит неопределённость в " +
      "отношениях: предпочитает назвать вещи своими именами, даже если это " +
      "неудобный разговор. Восстанавливается в тишине, руками — керамика, " +
      "прогулки, что-то медленное. Ценит, когда человек чем-то по-настоящему " +
      "увлечён, и совершенно не ценит попытки произвести впечатление.",
    fridayVibeText:
      "Маленькое место, где нас никто не торопит, хорошее вино и разговор, " +
      "который уходит куда-то не туда — в лучшем смысле.",
    vibeFocusText: "Скорее человек, но атмосфера должна не мешать.",
    energyAxis: -0.15,
    orientationAxis: 0.7,
    anchorTags: ["искусство", "керамика", "кино", "медленный отдых"],
    eloScore: 520,
  },
];

/**
 * Which puppet this visitor should meet.
 *
 * Reads the visitor's own `preference` first — that is the question the product
 * actually asked them ("who do you want to see?") — and falls back to the
 * opposite of their gender when preference is `both` or missing, so the demo
 * always has someone to show rather than dead-ending.
 */
export function pickDemoPartner(visitor: {
  gender: Gender | null;
  preference: GenderPreference | null;
}): DemoPartnerDefinition {
  const male = DEMO_PARTNERS.find((p) => p.gender === "male")!;
  const female = DEMO_PARTNERS.find((p) => p.gender === "female")!;

  if (visitor.preference === "men") return male;
  if (visitor.preference === "women") return female;
  // `both`, or an incomplete profile: show the opposite gender, which is what
  // a visitor demoing a straight-dating product almost always expects.
  return visitor.gender === "female" ? male : female;
}

/**
 * Create or refresh both puppets. Idempotent — safe to call on every demo boot.
 *
 * Deliberately does NOT touch `photos` / `profileMedia` / `photoFaceScores`:
 * those are uploaded separately by `scripts/seed-demo-partners.mjs` (Telegram
 * `file_id`s are per-bot, so they cannot be checked into the repo), and a
 * definition change must never wipe them.
 */
export async function seedDemoPartners(): Promise<void> {
  for (const partner of DEMO_PARTNERS) {
    await upsertDemoPartner(partner);
  }
}

async function upsertDemoPartner(partner: DemoPartnerDefinition): Promise<void> {
  const market = DEFAULT_MARKET;
  const now = new Date();

  const userFields = {
    firstName: partner.firstName,
    age: partner.age,
    gender: partner.gender,
    preference: partner.preference,
    language: "ru" as const,
    platform: "mobile" as const,
    status: "active" as const,
    onboardingStep: "completed" as const,
    // General track + a verified phone timestamp satisfies
    // TRACK_VERIFIED_CONTACT_WHERE without inventing a phone number: `phone`
    // is nullable, and Postgres allows many NULLs under a unique index.
    registrationTrack: "general",
    phoneVerifiedAt: now,
    verificationStatus: "verified" as const,
    verifiedAt: now,
    hasConsented: true,
    consentedAt: now,
    termsAccepted: true,
    termsAcceptedAt: now,
  };

  const profileFields = {
    height: partner.height,
    hobbies: partner.hobbies,
    partnerPreferences: partner.partnerPreferences,
    psychologicalSummary: partner.psychologicalSummary,
    fridayVibeText: partner.fridayVibeText,
    vibeFocusText: partner.vibeFocusText,
    energyAxis: partner.energyAxis,
    orientationAxis: partner.orientationAxis,
    anchorTags: partner.anchorTags,
    vibeExtractedAt: now,
    eloScore: partner.eloScore,
    eloSeededAt: now,
    homeCity: market.city,
    homeCityKey: market.cityKey,
    homeCountryCode: market.countryCode,
    latitude: market.latitude,
    longitude: market.longitude,
    locationUpdatedAt: now,
    timeZone: cityKeyToTimeZone(market.cityKey),
    // Dirty on purpose, and cleared below by a real embedding.
    //
    // `createProposedMatch` re-checks eligibility through
    // `loadEligibleUsersForIds`, whose last step is
    // `.filter((u) => embeddingMap.get(u.id))` — an embedding is REQUIRED even
    // when the pair is named explicitly and never goes through the pgvector
    // candidate search. A puppet without one is silently dropped from the
    // snapshot and every pitch is refused.
    embeddingDirty: true,
  };

  const user = await prisma.user.upsert({
    where: { telegramId: partner.telegramId },
    create: { telegramId: partner.telegramId, ...userFields },
    update: userFields,
    select: { id: true },
  });

  await prisma.profile.upsert({
    where: { userId: user.id },
    create: { userId: user.id, ...profileFields },
    update: profileFields,
  });

  // Build the vector through the production refresher rather than writing one
  // here, so the puppet's embedding can never drift from how a real profile's
  // is derived. It reads the same `psychologicalSummary` the pitch generator
  // does, so the demo's synergy copy describes a genuinely comparable profile.
  const refreshed = await refreshUserEmbedding(user.id);
  if (refreshed.failed > 0 || refreshed.refreshed === 0) {
    console.warn(
      `[demo] embedding refresh did not complete for ${partner.firstName} — ` +
        `the puppet stays ineligible until it does (matching requires a vector)`,
    );
  }
}

/**
 * Make these people matchable again — **both sides, not just the puppet**.
 *
 * `createProposedMatch` stamps `lastMatchedAt` on both participants and
 * `loadEligibleUsersForIds` enforces `lastMatchedAt < now − CADENCE.cooldownMs`
 * (24h under the weekly profile) on every id it is handed, including a pair
 * named explicitly. So one match makes the VISITOR ineligible for a day too,
 * and the demo's whole recovery path — decline, «continue the demo», or simply
 * wanting to see the pitch again — silently produced no match at all: the
 * driver just retried every tick and logged `createProposedMatch refused`.
 *
 * Releasing only the puppet was the original bug. The cooldown exists to stop a
 * real candidate being served up day after day; neither a stage prop nor a
 * fifteen-minute demo account is that. Nothing else in the demo database reads
 * this column — the drop cron is not scheduled here (DEMO_MODE.md) — so this
 * allocator is its only consumer.
 */
export async function releaseMatchCooldown(userIds: readonly string[]): Promise<void> {
  if (userIds.length === 0) return;
  await prisma.profile.updateMany({
    where: { userId: { in: [...userIds] } },
    data: { lastMatchedAt: null },
  });
}

/**
 * Rebuild any stale vector NOW instead of waiting for the 5-minute cron.
 *
 * The twin of `releaseMatchCooldown` above: a production precondition that is
 * right for a weekly batch and wrong for a demo measured in minutes. Matching
 * fail-closes on the seeker's own `embeddingDirty`, so a stale flag is not a
 * slow match — it is no match at all until the cron catches up.
 *
 * **A guard, not the fix for the decline race.** That race — a rejection reason
 * writing `negativeConstraints`, flipping the flag, and withholding the user
 * from the very next pitch — was a PRODUCTION bug and is fixed where it
 * belongs, in `appendNegativeConstraint`, which now attempts the immediate
 * refresh every other embedding-feeding writer already did (DECISIONS.md,
 * 2026-08-08). This exists because not every path that dirties the flag
 * refreshes it: a finalize whose initial embedding failed deliberately leaves
 * the profile dirty for the worker to retry, and a demo cannot afford to wait
 * out that retry in front of an audience.
 *
 * Costs nothing when the vector is clean — the query filters on the flag — and
 * `refreshUserEmbedding` is the same production refresher the puppet is seeded
 * through, so nothing about how a vector is derived is special-cased for demo.
 */
export async function ensureFreshEmbeddings(userIds: readonly string[]): Promise<void> {
  if (userIds.length === 0) return;
  const stale = await prisma.profile.findMany({
    where: { userId: { in: [...userIds] }, embeddingDirty: true },
    select: { userId: true },
  });
  for (const { userId } of stale) {
    const result = await refreshUserEmbedding(userId).catch((err: unknown) => {
      console.warn(`[demo] embedding refresh threw for ${userId}:`, err);
      return { refreshed: 0, failed: 1 };
    });
    if (result.failed > 0 || result.refreshed === 0) {
      // Not fatal here: the caller's own refusal path reports it, and the next
      // tick tries again. Saying it once keeps a persistent OpenAI failure
      // distinguishable from an ordinary allocator refusal.
      console.warn(`[demo] embedding still stale for ${userId} — pitch will be refused`);
    }
  }
}

/**
 * Make sure the puppet can pay for its own Date Ticket.
 *
 * The §3.5b gate needs BOTH slots settled before the Calendar is sent, and a
 * visitor who chooses "pay only mine" leaves the puppet's slot open. The demo
 * settles it through `useTicketFromBalance` — a real production path, the one a
 * partner with a ticket in their wallet would take — and that path refuses at a
 * zero balance, which is where every seeded puppet starts. So the flow simply
 * stopped: `insufficient-balance` every tick, no Calendar, no way forward, and
 * nobody to chase for the missing half.
 *
 * Topped up on demand rather than seeded with a lump, so it is still right
 * after a process that has been up for weeks and many demos. The ledger row is
 * stage bookkeeping in a throwaway database: no money moves (demo runs
 * `TICKET_PAYMENT_MODE=mock` with Stars off), which is why `amountCents` is
 * left unset.
 */
export async function ensurePuppetTicket(userId: string): Promise<void> {
  if ((await getBalance(userId)) >= 1) return;
  await grantTickets({ userId, count: 1, reason: "store_purchase" });
}

/** Resolve a seeded puppet's `User.id`, or null if it has not been seeded. */
export async function findDemoPartnerId(telegramId: bigint): Promise<string | null> {
  const row = await prisma.user.findUnique({
    where: { telegramId },
    select: { id: true },
  });
  return row?.id ?? null;
}

/** True when this user id belongs to one of the puppets. */
/**
 * Which of these user ids are puppets.
 *
 * Exists because the allocator has to ask that question INSIDE its own
 * transaction, against the locked rows, so `isDemoPartner` above — which opens
 * its own `prisma` connection and takes one id — cannot answer it. Takes the
 * transaction client and the whole participant list instead.
 *
 * Identification is the reserved `telegramId` band and nothing else. There is
 * deliberately no column to check: DEMO_MODE.md forbids a demo-only field in
 * `schema.prisma`, because the schema is shared and would ship to the
 * production database. A negative id in this band exists only in the demo
 * database, and only `seedDemoPartners()` writes one.
 */
export async function demoPuppetIdsAmong(
  db: Pick<Prisma.TransactionClient, "user">,
  userIds: readonly string[],
): Promise<string[]> {
  if (userIds.length === 0) return [];
  const rows = await db.user.findMany({
    where: {
      id: { in: [...userIds] },
      telegramId: { in: DEMO_PARTNERS.map((partner) => partner.telegramId) },
    },
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

export async function isDemoPartner(userId: string): Promise<boolean> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { telegramId: true },
  });
  if (!row) return false;
  return DEMO_PARTNERS.some((p) => p.telegramId === row.telegramId);
}
