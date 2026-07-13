import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@gennety/db", () => ({
  prisma: {
    $transaction: vi.fn(),
    webRegistrationLink: { create: vi.fn(), updateMany: vi.fn(), findUnique: vi.fn() },
    user: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn() },
    userSession: { count: vi.fn() },
  },
}));

vi.mock("../public/home-location.js", () => ({
  saveHomeLocationForUser: vi.fn(),
}));

import { prisma } from "@gennety/db";
import { saveHomeLocationForUser } from "../public/home-location.js";
import { createWebRegistrationLink, consumeWebRegistrationLink } from "./web-registration.js";

const mock = (fn: unknown): ReturnType<typeof vi.fn> => fn as ReturnType<typeof vi.fn>;

const KYIV = {
  homeCity: "Kyiv",
  homeCountryCode: "UA",
  homeCityKey: "ua:kyiv",
  homePlaceId: "place-1",
  latitude: 50.45,
  longitude: 30.52,
};

/** Drive the transaction callback against the mocked client. */
function runTransaction(): void {
  mock(prisma.$transaction).mockImplementation(async (arg: unknown) =>
    typeof arg === "function" ? await (arg as (tx: unknown) => Promise<unknown>)(prisma) : arg,
  );
}

describe("createWebRegistrationLink", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runTransaction();
    mock(prisma.webRegistrationLink.create).mockResolvedValue({});
    mock(prisma.webRegistrationLink.updateMany).mockResolvedValue({ count: 0 });
  });

  it("stores the email, domain and city for the student track", async () => {
    await createWebRegistrationLink({
      track: "student",
      email: "Anna@Kyiv.edu",
      city: KYIV,
      language: "uk",
      purpose: "join",
      termsAccepted: true,
      researchOptIn: false,
    });

    const data = mock(prisma.webRegistrationLink.create).mock.calls[0][0].data;
    expect(data).toMatchObject({
      registrationTrack: "student",
      email: "anna@kyiv.edu",
      universityDomain: "kyiv.edu",
      homeCityKey: "ua:kyiv",
      latitude: 50.45,
    });
  });

  it("mints a general-track link with no email and no city", async () => {
    await createWebRegistrationLink({
      track: "general",
      language: "en",
      purpose: "join",
      termsAccepted: true,
      researchOptIn: false,
    });

    const data = mock(prisma.webRegistrationLink.create).mock.calls[0][0].data;
    expect(data).toMatchObject({
      registrationTrack: "general",
      email: null,
      universityDomain: null,
      homeCityKey: null,
    });
    // Superseding older links is keyed by email; there is none to key on.
    expect(prisma.webRegistrationLink.updateMany).not.toHaveBeenCalled();
  });
});

describe("consumeWebRegistrationLink", () => {
  const token = "a".repeat(32);

  const link = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: "link-1",
    email: "anna@kyiv.edu",
    universityDomain: "kyiv.edu",
    registrationTrack: "student",
    language: "uk",
    purpose: "join",
    termsAccepted: true,
    termsAcceptedAt: new Date("2026-07-13T10:00:00Z"),
    researchOptIn: false,
    consumedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
    homeCity: null,
    homeCountryCode: null,
    homeCityKey: null,
    homePlaceId: null,
    latitude: null,
    longitude: null,
    ...over,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    runTransaction();
    mock(prisma.webRegistrationLink.updateMany).mockResolvedValue({ count: 1 });
    mock(prisma.user.findUnique).mockResolvedValue(null);
    mock(prisma.user.create).mockImplementation(
      async (args: { data: Record<string, unknown> }) => ({ id: "user-1", ...args.data }),
    );
  });

  it("the general track NEVER arrives pre-verified — the web cannot vouch for a phone", async () => {
    mock(prisma.webRegistrationLink.findUnique).mockResolvedValue(
      link({ registrationTrack: "general", email: null, universityDomain: null }),
    );

    const result = await consumeWebRegistrationLink(token, 55n);
    expect(result.kind).toBe("linked");
    if (result.kind !== "linked") return;
    expect(result.track).toBe("general");

    const created = mock(prisma.user.create).mock.calls[0][0].data;
    // The whole point: consent + language carry over, a contact rail does not.
    expect(created.termsAccepted).toBe(true);
    expect(created.registrationTrack).toBe("general");
    expect(created.isEmailVerified).toBeUndefined();
    expect(created.email).toBeUndefined();
    expect(created.phoneVerifiedAt).toBeUndefined();
  });

  it("the student track carries the verified email through", async () => {
    mock(prisma.webRegistrationLink.findUnique).mockResolvedValue(link());

    const result = await consumeWebRegistrationLink(token, 55n);
    expect(result.kind).toBe("linked");
    if (result.kind !== "linked") return;
    expect(result.track).toBe("student");

    const created = mock(prisma.user.create).mock.calls[0][0].data;
    expect(created).toMatchObject({
      email: "anna@kyiv.edu",
      isEmailVerified: true,
      registrationTrack: "student",
    });
  });

  it("persists the city picked on the website so Telegram never re-asks it", async () => {
    mock(prisma.webRegistrationLink.findUnique).mockResolvedValue(
      link({
        homeCity: "Kyiv",
        homeCountryCode: "UA",
        homeCityKey: "ua:kyiv",
        homePlaceId: "place-1",
        latitude: 50.45,
        longitude: 30.52,
      }),
    );

    await consumeWebRegistrationLink(token, 55n);

    expect(saveHomeLocationForUser).toHaveBeenCalledWith("user-1", expect.objectContaining(KYIV));
  });

  it("a failed city write still links the account (the user just picks it in-app)", async () => {
    mock(prisma.webRegistrationLink.findUnique).mockResolvedValue(
      link({
        homeCity: "Kyiv",
        homeCountryCode: "UA",
        homeCityKey: "ua:kyiv",
        homePlaceId: null,
        latitude: 50.45,
        longitude: 30.52,
      }),
    );
    mock(saveHomeLocationForUser).mockRejectedValue(new Error("db down"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await consumeWebRegistrationLink(token, 55n);
    expect(result.kind).toBe("linked");
    err.mockRestore();
  });

  it("a legacy link with no track reads as student (they all carried an email)", async () => {
    mock(prisma.webRegistrationLink.findUnique).mockResolvedValue(
      link({ registrationTrack: null }),
    );

    const result = await consumeWebRegistrationLink(token, 55n);
    expect(result.kind).toBe("linked");
    if (result.kind !== "linked") return;
    expect(result.track).toBe("student");
    expect(mock(prisma.user.create).mock.calls[0][0].data.isEmailVerified).toBe(true);
  });

  it("skips the email-collision lookup entirely when the link has no email", async () => {
    mock(prisma.webRegistrationLink.findUnique).mockResolvedValue(
      link({ registrationTrack: "general", email: null, universityDomain: null }),
    );

    await consumeWebRegistrationLink(token, 55n);

    // Only the telegramId lookup — never `where: { email: null }`, which Prisma
    // would reject.
    const lookups = mock(prisma.user.findUnique).mock.calls;
    expect(lookups).toHaveLength(1);
    expect(lookups[0][0]).toEqual({ where: { telegramId: 55n } });
  });
});
