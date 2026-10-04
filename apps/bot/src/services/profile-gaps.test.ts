import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ findUnique: vi.fn(), countMusic: vi.fn() }));

vi.mock("@gennety/db", () => ({ prisma: { user: { findUnique: h.findUnique } } }));
vi.mock("./music/profile-music.js", () => ({ countProfileMusic: h.countMusic }));
vi.mock("../config.js", () => ({
  env: {
    PROFILE_VIDEO_API_ENABLED: true,
    PROFILE_MUSIC_ENABLED: false,
    VOICE_PROMPT_ENABLED: false,
    TYPE_RADAR_ENABLED: false,
    TICKET_FEATURE_ENABLED: true,
  },
}));

const {
  PHOTO_BONUS_GRANTED_BY_APP_UPLOAD,
  PROFILE_GAP_ORDER,
  computeProfileGaps,
  isAboutMissing,
  loadProfileGaps,
  profileGapFlagsFromEnv,
} = await import("./profile-gaps.js");
type Snapshot = Parameters<typeof computeProfileGaps>[0];
type Flags = Parameters<typeof computeProfileGaps>[1];

const USER_ID = "11111111-1111-4111-8111-111111111111";
const VIDEO_MEDIA = { type: "video", video: "u/video.mp4", thumb: "u/thumb.jpg", duration: 9 };

/**
 * `profileMedia` as the server stores it: one item per static photo, aligned
 * with `photos[]`, plus the video. A slot that does not line up with
 * `photos[]` is discarded by `normalizeProfileMedia` — and the video with it.
 */
function mediaWithVideo(photos: string[]): unknown[] {
  return [...photos.map((photo) => ({ type: "photo", photo })), VIDEO_MEDIA];
}

/** Every feature on, nothing filled in. */
const ALL_ON: Flags = {
  videoEnabled: true,
  musicEnabled: true,
  voiceEnabled: true,
  typeRadarEnabled: true,
  ticketsEnabled: true,
  photoBonusOnAppUpload: true,
};

function emptySnapshot(): Snapshot {
  return {
    major: null,
    age: 22,
    preference: "women",
    hasVoicePrompt: false,
    musicTrackCount: 0,
    profile: {
      photos: ["p/1.jpg", "p/2.jpg", "p/3.jpg", "p/4.jpg"],
      profileMedia: [],
      photoBonusTicketAt: null,
      videoBonusTicketAt: null,
      partnerPreferences: null,
      ageRangeMin: null,
      ageRangeMax: null,
      psychologicalSummary: null,
      hobbies: [],
      typePrefTags: null,
    },
  };
}

/** Nothing open: a profile someone actually finished. */
function completeSnapshot(): Snapshot {
  return {
    major: "Architecture",
    age: 22,
    preference: "women",
    hasVoicePrompt: true,
    musicTrackCount: 2,
    profile: {
      photos: ["1", "2", "3", "4", "5", "6"],
      profileMedia: mediaWithVideo(["1", "2", "3", "4", "5", "6"]),
      photoBonusTicketAt: new Date("2026-09-01T10:00:00Z"),
      videoBonusTicketAt: new Date("2026-09-01T10:05:00Z"),
      partnerPreferences: "Someone curious who likes long walks",
      ageRangeMin: 20,
      ageRangeMax: 27,
      psychologicalSummary: "I build furniture and read too much sci-fi.",
      hobbies: ["climbing"],
      typePrefTags: { female: { hair: 0.4 } },
    },
  };
}

function kinds(snapshot: Snapshot, flags: Flags = ALL_ON): string[] {
  return computeProfileGaps(snapshot, flags).map((gap) => gap.kind);
}

function gapOf(snapshot: Snapshot, kind: string, flags: Flags = ALL_ON) {
  return computeProfileGaps(snapshot, flags).find((gap) => gap.kind === kind);
}

describe("computeProfileGaps — order", () => {
  it("lists every open item in the fixed priority order", () => {
    expect(kinds(emptySnapshot())).toEqual([...PROFILE_GAP_ORDER]);
    expect(PROFILE_GAP_ORDER).toEqual([
      "video",
      "photos",
      "music",
      "looking_for",
      "age_range",
      "about",
      "interests",
      "voice",
      "type_radar",
      "major",
    ]);
  });

  it("returns nothing for a finished profile", () => {
    expect(computeProfileGaps(completeSnapshot(), ALL_ON)).toEqual([]);
  });

  it("keeps the order when only some items are open", () => {
    const snapshot = completeSnapshot();
    snapshot.major = null;
    snapshot.profile!.hobbies = [];
    snapshot.musicTrackCount = 0;
    expect(kinds(snapshot)).toEqual(["music", "interests", "major"]);
  });

  it("treats a missing profile row as nothing filled in", () => {
    const snapshot = { ...emptySnapshot(), profile: null };
    expect(kinds(snapshot)).toEqual([...PROFILE_GAP_ORDER]);
  });
});

describe("computeProfileGaps — video", () => {
  it("is open with a ticket while the video bonus was never granted", () => {
    expect(gapOf(emptySnapshot(), "video")).toEqual({ kind: "video", reward: "ticket" });
  });

  it("is open WITHOUT a reward once the bonus was granted (video since removed)", () => {
    const snapshot = emptySnapshot();
    snapshot.profile!.videoBonusTicketAt = new Date();
    expect(gapOf(snapshot, "video")).toEqual({ kind: "video" });
  });

  it("carries no reward while tickets are switched off", () => {
    expect(gapOf(emptySnapshot(), "video", { ...ALL_ON, ticketsEnabled: false })).toEqual({
      kind: "video",
    });
  });

  it("closes when the profile holds a video", () => {
    const snapshot = emptySnapshot();
    snapshot.profile!.profileMedia = mediaWithVideo(snapshot.profile!.photos);
    expect(kinds(snapshot)).not.toContain("video");
  });

  it("is absent while the profile-video API is off", () => {
    expect(kinds(emptySnapshot(), { ...ALL_ON, videoEnabled: false })).not.toContain("video");
  });
});

describe("computeProfileGaps — photos", () => {
  it("reports how many photos are left to the bonus threshold", () => {
    expect(gapOf(emptySnapshot(), "photos")).toEqual({
      kind: "photos",
      reward: "ticket",
      remaining: 2,
    });
  });

  it("promises no ticket while the app upload does not grant the bonus", () => {
    const flags = { ...ALL_ON, photoBonusOnAppUpload: false };
    expect(gapOf(emptySnapshot(), "photos", flags)).toEqual({ kind: "photos", remaining: 2 });
  });

  it("promises no ticket while tickets are switched off", () => {
    const flags = { ...ALL_ON, ticketsEnabled: false };
    expect(gapOf(emptySnapshot(), "photos", flags)).toEqual({ kind: "photos", remaining: 2 });
  });

  it("is not a gap once the bonus was claimed, even below the threshold", () => {
    const snapshot = emptySnapshot();
    snapshot.profile!.photoBonusTicketAt = new Date();
    expect(kinds(snapshot)).not.toContain("photos");
  });

  it("closes at the threshold", () => {
    const snapshot = emptySnapshot();
    snapshot.profile!.photos = ["1", "2", "3", "4", "5", "6"];
    expect(kinds(snapshot)).not.toContain("photos");
  });
});

describe("computeProfileGaps — feature-flagged items", () => {
  it("music: open with no pinned track, closed with one, absent while off", () => {
    expect(kinds(emptySnapshot())).toContain("music");
    expect(kinds({ ...emptySnapshot(), musicTrackCount: 1 })).not.toContain("music");
    expect(kinds(emptySnapshot(), { ...ALL_ON, musicEnabled: false })).not.toContain("music");
  });

  it("voice: open with no recording, closed with one, absent while off", () => {
    expect(kinds(emptySnapshot())).toContain("voice");
    expect(kinds({ ...emptySnapshot(), hasVoicePrompt: true })).not.toContain("voice");
    expect(kinds(emptySnapshot(), { ...ALL_ON, voiceEnabled: false })).not.toContain("voice");
  });

  it("type_radar: open while available and uncalibrated, absent while off", () => {
    expect(kinds(emptySnapshot())).toContain("type_radar");
    expect(kinds(emptySnapshot(), { ...ALL_ON, typeRadarEnabled: false })).not.toContain(
      "type_radar",
    );
  });

  it("type_radar: closed once calibrated", () => {
    const snapshot = emptySnapshot();
    snapshot.profile!.typePrefTags = { female: {} };
    expect(kinds(snapshot)).not.toContain("type_radar");
  });

  it("type_radar: absent when the deck could not be served (same gates as /v1/radar/state)", () => {
    // band B has no live portrait set yet
    expect(kinds({ ...emptySnapshot(), age: 33 })).not.toContain("type_radar");
    // profile not ready: no age, or no preference
    expect(kinds({ ...emptySnapshot(), age: null })).not.toContain("type_radar");
    expect(kinds({ ...emptySnapshot(), preference: null })).not.toContain("type_radar");
  });
});

describe("computeProfileGaps — profile fields", () => {
  it("looking_for: open when blank, closed when written", () => {
    const blank = emptySnapshot();
    blank.profile!.partnerPreferences = "   ";
    expect(kinds(blank)).toContain("looking_for");
    const written = emptySnapshot();
    written.profile!.partnerPreferences = "Kind and funny";
    expect(kinds(written)).not.toContain("looking_for");
  });

  it("age_range: open only while BOTH bounds are empty", () => {
    expect(kinds(emptySnapshot())).toContain("age_range");
    const minOnly = emptySnapshot();
    minOnly.profile!.ageRangeMin = 21;
    expect(kinds(minOnly)).not.toContain("age_range");
    const maxOnly = emptySnapshot();
    maxOnly.profile!.ageRangeMax = 30;
    expect(kinds(maxOnly)).not.toContain("age_range");
  });

  it("interests: open when the list is empty or holds only blanks", () => {
    expect(kinds(emptySnapshot())).toContain("interests");
    const blanks = emptySnapshot();
    blanks.profile!.hobbies = [" ", ""];
    expect(kinds(blanks)).toContain("interests");
    const filled = emptySnapshot();
    filled.profile!.hobbies = ["chess"];
    expect(kinds(filled)).not.toContain("interests");
  });

  it("major: open when null or blank", () => {
    expect(kinds({ ...emptySnapshot(), major: null })).toContain("major");
    expect(kinds({ ...emptySnapshot(), major: "  " })).toContain("major");
    expect(kinds({ ...emptySnapshot(), major: "Law" })).not.toContain("major");
  });

  it("about: open for the onboarding stub, closed for the person's own text", () => {
    const stub = emptySnapshot();
    stub.profile!.psychologicalSummary =
      "Profile source: onboarding answers\nHobbies/interests: chess\nPartner preferences: kind";
    expect(kinds(stub)).toContain("about");
    const own = emptySnapshot();
    own.profile!.psychologicalSummary = "Night owl, bakes bread on Sundays.";
    expect(kinds(own)).not.toContain("about");
  });
});

describe("isAboutMissing", () => {
  it("is missing when empty or blank", () => {
    expect(isAboutMissing(null)).toBe(true);
    expect(isAboutMissing(undefined)).toBe(true);
    expect(isAboutMissing("")).toBe(true);
    expect(isAboutMissing("  \n ")).toBe(true);
  });

  it("is missing for the stub onboarding finalize writes today", () => {
    expect(
      isAboutMissing(
        [
          "Profile source: onboarding answers",
          "Hobbies/interests: none provided",
          "Partner preferences: someone kind",
          "Ideal Friday night: board games",
        ].join("\n"),
      ),
    ).toBe(true);
  });

  it("is missing for both pre-2026-09-24 variants of the stub", () => {
    expect(
      isAboutMissing(
        "Profile source: onboarding answers (AI memory export declined)\nHobbies/interests: x\nPartner preferences: y",
      ),
    ).toBe(true);
    expect(
      isAboutMissing(
        "Profile source: onboarding answers (AI memory contained no supported dating signals)\nHobbies/interests: x",
      ),
    ).toBe(true);
  });

  it("is missing for a retired Magic Prompt import summary", () => {
    expect(
      isAboutMissing(
        [
          "Summary: Thoughtful, slow to warm up, loyal once close.",
          "Relationships: values steady routines; dislikes ambiguity",
          "Sustained interests: rock climbing; jazz",
          "Ideal Friday night: a small dinner with friends",
        ].join("\n"),
      ),
    ).toBe(true);
    expect(
      isAboutMissing("Personality: calm, curious\nInterests: climbing\nValues: honesty"),
    ).toBe(true);
  });

  it("is present for text the person wrote", () => {
    expect(isAboutMissing("I build furniture and read too much sci-fi.")).toBe(false);
    expect(isAboutMissing("Summary: I'm a calm person who loves the sea.")).toBe(false);
    expect(isAboutMissing("Love hiking.\nInterests: chess, sailing")).toBe(false);
  });
});

describe("loadProfileGaps", () => {
  beforeEach(() => {
    h.findUnique.mockReset();
    h.countMusic.mockReset();
  });

  function userRow(over: Record<string, unknown> = {}) {
    const snap = emptySnapshot();
    return {
      major: snap.major,
      age: snap.age,
      preference: snap.preference,
      voicePrompt: null,
      profile: snap.profile,
      ...over,
    };
  }

  it("reads the user in ONE query and counts music only while it is on", async () => {
    h.findUnique.mockResolvedValue(userRow());
    h.countMusic.mockResolvedValue(0);

    const gaps = await loadProfileGaps(USER_ID, { ...ALL_ON, musicEnabled: false });

    expect(h.findUnique).toHaveBeenCalledTimes(1);
    expect(h.findUnique.mock.calls[0]![0]).toMatchObject({ where: { id: USER_ID } });
    expect(h.countMusic).not.toHaveBeenCalled();
    expect(gaps!.map((gap) => gap.kind)).not.toContain("music");
  });

  it("passes the music count and the voice-prompt row through", async () => {
    h.findUnique.mockResolvedValue(userRow({ voicePrompt: { id: "vp" } }));
    h.countMusic.mockResolvedValue(0);

    const gaps = await loadProfileGaps(USER_ID, ALL_ON);

    expect(h.countMusic).toHaveBeenCalledWith(USER_ID);
    const listed = gaps!.map((gap) => gap.kind);
    expect(listed).toContain("music");
    expect(listed).not.toContain("voice");
  });

  it("returns null for an unknown user", async () => {
    h.findUnique.mockResolvedValue(null);
    expect(await loadProfileGaps(USER_ID, ALL_ON)).toBeNull();
  });

  it("takes its flags from env, and the photo bonus stays off the app rail", () => {
    expect(PHOTO_BONUS_GRANTED_BY_APP_UPLOAD).toBe(false);
    expect(profileGapFlagsFromEnv()).toEqual({
      videoEnabled: true,
      musicEnabled: false,
      voiceEnabled: false,
      typeRadarEnabled: false,
      ticketsEnabled: true,
      photoBonusOnAppUpload: false,
    });
  });
});
