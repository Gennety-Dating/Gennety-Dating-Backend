import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  user: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn() },
  profile: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn() },
}));

vi.mock("@gennety/db", () => ({ prisma: db }));
vi.mock("./ticket-wallet.js", () => ({ getBalance: vi.fn(), grantTickets: vi.fn() }));

const {
  APP_REVIEW_PARTNER_PHOTOS,
  APP_REVIEW_PARTNER_TELEGRAM_ID,
  ensureAppReviewPartner,
  ensureAppReviewReviewer,
} = await import("./app-review.js");

const ON = { APP_REVIEW_EMAIL: "review@gennety.com", APP_REVIEW_CODE: "583014" };

beforeEach(() => {
  vi.clearAllMocks();
  db.user.update.mockImplementation(({ where }) => Promise.resolve({ id: where.id }));
  db.user.create.mockImplementation(() => Promise.resolve({ id: "new-user" }));
});

describe("app review personas", () => {
  it("creates the partner as Gleb with the founder's photos", async () => {
    db.user.findUnique.mockResolvedValue(null);
    db.profile.findUnique.mockResolvedValue(null);

    await ensureAppReviewPartner();

    const created = db.user.create.mock.calls[0]![0].data;
    expect(created).toMatchObject({
      telegramId: APP_REVIEW_PARTNER_TELEGRAM_ID,
      firstName: "Gleb",
      gender: "male",
      preference: "women",
    });
    expect(db.profile.create.mock.calls[0]![0].data.photos).toEqual(APP_REVIEW_PARTNER_PHOTOS);
  });

  it("gives an older partner row without pictures the photos, once", async () => {
    db.user.findUnique.mockResolvedValue({ id: "p1", verifiedAt: null, consentedAt: null, termsAcceptedAt: null });
    db.profile.findUnique.mockResolvedValueOnce({ userId: "p1", photos: [] });

    await ensureAppReviewPartner();
    expect(db.profile.update).toHaveBeenCalledWith({
      where: { userId: "p1" },
      data: { photos: APP_REVIEW_PARTNER_PHOTOS },
    });

    db.profile.update.mockClear();
    db.profile.findUnique.mockResolvedValueOnce({ userId: "p1", photos: [...APP_REVIEW_PARTNER_PHOTOS] });
    await ensureAppReviewPartner();
    expect(db.profile.update).not.toHaveBeenCalled();
    expect(db.profile.create).not.toHaveBeenCalled();
  });

  it("creates the reviewer as a woman and never touches the reviewer's own photos", async () => {
    db.user.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    db.profile.findUnique.mockResolvedValueOnce(null);
    await ensureAppReviewReviewer(ON);
    expect(db.user.create.mock.calls[0]![0].data).toMatchObject({
      firstName: "Alex",
      gender: "female",
      preference: "men",
    });
    expect(db.profile.create.mock.calls[0]![0].data.photos).toEqual([]);

    db.user.findUnique.mockResolvedValue({ id: "r1", telegramId: -779_000_001n, verifiedAt: null, consentedAt: null, termsAcceptedAt: null });
    db.profile.findUnique.mockResolvedValueOnce({ userId: "r1", photos: ["r1/own.jpg"] });
    await ensureAppReviewReviewer(ON);
    expect(db.profile.update).not.toHaveBeenCalled();
  });
});
