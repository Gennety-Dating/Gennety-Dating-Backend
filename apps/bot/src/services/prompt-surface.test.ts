import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The shared prompt per surface (app audit 2026-11-15, item 1): the app's chat
 * agent was told it lives in Telegram. The app surface now names the app's
 * own screens; the Telegram surface must not move by a single byte.
 *
 * `__fixtures__/prompt-tg-baseline.json` was recorded from the code BEFORE the
 * surface parameter existed. Every Telegram prompt below is compared with it
 * whole, so any drift in the Telegram wording fails here.
 */

vi.mock("@gennety/db", () => ({
  prisma: {
    systemKnowledge: { findMany: vi.fn() },
    user: { findUnique: vi.fn() },
    match: { findFirst: vi.fn() },
    chatEvent: { findMany: vi.fn() },
  },
}));

vi.mock("../config.js", () => ({
  env: {
    BOT_TOKEN: "test",
    DATABASE_URL: "test",
    OPENAI_API_KEY: "test-key",
    COORDINATION_FEATURE_ENABLED: true,
    VENUE_CHANGE_FEATURE_ENABLED: true,
    TICKET_FEATURE_ENABLED: true,
    PREMIUM_FEATURE_ENABLED: true,
    REMATCH_FEATURE_ENABLED: true,
    EARLY_STAGE: false,
    TICKET_PRICE_CENTS: 699,
    PREMIUM_PRICE_USD_DISPLAY: "$17.99",
    PREMIUM_STARS: 1000,
    REMATCH_PRICE_USD_DISPLAY: "$2.99",
    FIRST_DROP_CALIBRATION_HOURS: 24,
  },
}));

const { prisma } = await import("@gennety/db");
const { buildSystemPrompt, clearKnowledgeCache, describeActiveMatch } = await import("./prompt-builder.js");
const { buildProductPlaybook } = await import("./product-playbook.js");

const FIXTURE = new URL("./__fixtures__/prompt-tg-baseline.json", import.meta.url);
const NOW = new Date("2026-11-15T10:00:00.000Z");

const userFind = prisma.user.findUnique as ReturnType<typeof vi.fn>;
const knowledge = prisma.systemKnowledge.findMany as ReturnType<typeof vi.fn>;
const matchFind = prisma.match.findFirst as ReturnType<typeof vi.fn>;
const events = prisma.chatEvent.findMany as ReturnType<typeof vi.fn>;

const MATCH_BASE = {
  agreedTime: null,
  venueName: null,
  venueAddress: null,
  venueGoogleMapsUri: null,
  ticketStatus: null,
  proxyOpenedAt: null,
  proxyClosesAt: null,
  proxyClosedAt: null,
  venueChangeStatus: null,
  vibeTextA: null,
  vibeLatA: null,
  vibeLngA: null,
  vibeTextB: null,
  vibeLatB: null,
  vibeLngB: null,
  stallCheckInSentAtA: null,
  stallCheckInSentAtB: null,
  stallConfirmedAtA: null,
  stallConfirmedAtB: null,
  proposedTimes: [],
  dispatchedAt: null,
  schedulingOpenedAt: null,
  venuePromptAskedAt: null,
  userB: { firstName: "Anna" },
};

/** One account per stage, plus a non-Kyiv zone (the app renders it, Telegram must not). */
const CASES: Record<string, Record<string, unknown> | null> = {
  none: null,
  proposed: { ...MATCH_BASE, status: "proposed" },
  negotiating: { ...MATCH_BASE, status: "negotiating", ticketStatus: "pending" },
  venue_open: { ...MATCH_BASE, status: "negotiating_venue" },
  venue_mine_done: {
    ...MATCH_BASE,
    status: "negotiating_venue",
    vibeTextA: "quiet cafe",
    vibeLatA: 50.4,
    vibeLngA: 30.5,
    vibeTextB: "park",
    vibeLatB: 50.4,
    vibeLngB: 30.5,
  },
  scheduled: {
    ...MATCH_BASE,
    status: "scheduled",
    agreedTime: new Date("2026-11-15T16:00:00.000Z"),
    venueName: "Kavarnia",
    venueAddress: "Khreshchatyk 1",
    venueGoogleMapsUri: "https://maps.google.com/?cid=1",
    venueChangeStatus: "none",
  },
  scheduled_open_chat: {
    ...MATCH_BASE,
    status: "scheduled",
    agreedTime: new Date("2026-11-15T10:30:00.000Z"),
    venueName: "Kavarnia",
    proxyOpenedAt: new Date("2026-11-15T09:30:00.000Z"),
    proxyClosesAt: new Date("2026-11-15T12:30:00.000Z"),
  },
};

function userRow(match: Record<string, unknown> | null, timeZone: string | null) {
  return {
    id: "u1",
    firstName: "Max",
    gender: "male",
    universityDomain: "knu.ua",
    status: "active",
    language: "ru",
    ticketBalance: 2,
    premiumUntil: null,
    verificationStatus: "verified",
    profile: { homeCity: "Kyiv", calibrationUntil: null, timeZone },
    matchesAsA: match ? [match] : [],
    matchesAsB: [],
  };
}

let recorded: Record<string, string> = {};
const recording = !existsSync(FIXTURE);

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  if (!recording) recorded = JSON.parse(readFileSync(FIXTURE, "utf8")) as Record<string, string>;
});

afterAll(() => {
  vi.useRealTimers();
  if (recording) writeFileSync(FIXTURE, `${JSON.stringify(recorded, null, 2)}\n`);
});

beforeEach(() => {
  vi.clearAllMocks();
  clearKnowledgeCache();
  knowledge.mockResolvedValue([]);
  matchFind.mockResolvedValue(null);
  events.mockResolvedValue([]);
});

function same(key: string, actual: string): void {
  if (recording) {
    recorded[key] = actual;
    return;
  }
  expect(actual).toBe(recorded[key]);
}

describe("Telegram surface — byte-identical to the recorded baseline", () => {
  for (const [name, match] of Object.entries(CASES)) {
    it(`full system prompt: ${name}`, async () => {
      // A non-default zone on the profile: Telegram keeps the date card's zone.
      userFind.mockResolvedValue(userRow(match, "America/New_York"));
      same(`prompt:${name}`, await buildSystemPrompt(BigInt(1)));
    });
  }

  it("playbook with every feature on and every feature off", () => {
    same(
      "playbook:all",
      buildProductPlaybook({ coordination: true, venueChange: true, tickets: true, premium: true, rematch: true, earlyStage: true }),
    );
    same("playbook:none", buildProductPlaybook({ coordination: false, venueChange: false, tickets: false, premium: false }));
  });

  it("describeActiveMatch called the old way", () => {
    const view = {
      status: "scheduled",
      agreedTime: new Date("2026-11-15T16:00:00.000Z"),
      venueName: "Kavarnia",
      venueAddress: null,
      venueGoogleMapsUri: null,
      ticketStatus: null,
      proxyOpenedAt: null,
      proxyClosesAt: null,
      proxyClosedAt: null,
      venueChangeStatus: null,
      partnerFirstName: "Anna",
      venueSelfSubmitted: null,
      venuePartnerSubmitted: null,
      stallCheckInPending: false,
    };
    same(
      "match:scheduled",
      describeActiveMatch(view, NOW, "ru-RU", { coordination: false, venueChange: false, tickets: false, premium: false }),
    );
  });
});

describe("app surface", () => {
  async function appPrompt(name: keyof typeof CASES, zone: string | null = "America/New_York"): Promise<string> {
    userFind.mockResolvedValue(userRow(CASES[name] ?? null, zone));
    return buildSystemPrompt(BigInt(1), "app");
  }

  it.each(Object.keys(CASES))("%s: names no Telegram machinery and never calls itself a concierge", async (name) => {
    const prompt = await appPrompt(name);
    expect(prompt).not.toMatch(/Mini App/);
    expect(prompt).not.toMatch(/in-app concierge/);
    expect(prompt).not.toMatch(/\/start/);
    expect(prompt).not.toMatch(/\bDMs?\b/);
    expect(prompt).not.toMatch(/sent to Telegram|Telegram message/);
    expect(prompt).not.toMatch(/Enter chat|Open in Maps|Pick on map/);
    expect(prompt).not.toMatch(/[Tt]he concierge (?:then )?picks|concierge is picking/);
    expect(prompt).not.toMatch(/lands in this chat/);
  });

  it("names the app's own screens and App Store billing", async () => {
    const prompt = await appPrompt("none");
    expect(prompt).toContain("In the app: Today");
    expect(prompt).toContain("billed through the App Store");
    expect(prompt).toContain('"Pause matching" in Settings');
    expect(prompt).toContain("shown as its own bubble in the app's chat");
  });

  it("the venue step points at the app's map and Gennety picks the place", async () => {
    expect(await appPrompt("venue_open")).toContain('mark their departure point on the map ("Starting from?")');
    expect(await appPrompt("venue_mine_done")).toContain("Gennety is picking the venue now");
  });

  it("quotes the date in the profile's zone, Telegram in the date card's", async () => {
    // 16:00 UTC: 11:00 in New York, 18:00 in Kyiv.
    const app = await appPrompt("scheduled");
    expect(app).toContain("в 11:00 at Kavarnia");
    expect(app).toContain('"Open chat"');
    expect(app).toContain('"Get directions"');
    userFind.mockResolvedValue(userRow(CASES.scheduled ?? null, "America/New_York"));
    expect(await buildSystemPrompt(BigInt(1))).toContain("в 18:00 at Kavarnia");
  });

  it("an unknown or missing zone falls back to the date card's", async () => {
    expect(await appPrompt("scheduled", "Mars/Olympus")).toContain("в 18:00 at Kavarnia");
    expect(await appPrompt("scheduled", null)).toContain("в 18:00 at Kavarnia");
  });

  it("the playbook's app copy promises no rematch button", () => {
    const playbook = buildProductPlaybook(
      { coordination: true, venueChange: true, tickets: true, premium: true, rematch: true },
      undefined,
      undefined,
      "app",
    );
    expect(playbook).toContain("this app has no screen to buy it");
    expect(playbook).not.toContain("call `open_screen` with `rematch`");
  });
});
