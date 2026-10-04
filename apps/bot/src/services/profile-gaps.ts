import { prisma } from "@gennety/db";
import {
  PHOTO_BONUS_TICKET_THRESHOLD,
  normalizeProfileMedia,
  profileMediaHasVideo,
} from "@gennety/shared";
import { env } from "../config.js";
import { countProfileMusic } from "./music/profile-music.js";
import {
  typeRadarCalibrated,
  typeRadarUnavailableReason,
} from "./type-radar-availability.js";

/**
 * What is still unfinished on the caller's profile — `GET /v1/me/profile-gaps`
 * (founder decision 2026-10-01; iOS plan `docs/product/today-profile-hub-plan.md`,
 * section B, in the iOS repo).
 *
 * The iOS Today screen shows ONE nudge a day to finish one of these. The server
 * says only WHICH items are open; impressions, "later" and "never" live on the
 * client and nothing here knows about them. Read-only by construction.
 *
 * Every condition mirrors a fact some other surface already computes — this
 * module invents no completeness rule of its own:
 *   - video      — `videoEnabled` of `GET /v1/me/photos` + the profile media slot
 *                  the video bonus reads (`profileMediaHasVideo`);
 *   - photos     — `photosForBonusTicket` of `agent-insights.ts`;
 *   - music      — `PROFILE_MUSIC_ENABLED` (the gate of `/v1/me/music`) + rows;
 *   - voice      — `VOICE_PROMPT_ENABLED` (the gate of `/v1/me/voice-prompt`) + row;
 *   - type_radar — `available && !calibrated` of `GET /v1/radar/state`;
 *   - the rest   — the plain profile columns the editor writes.
 *
 * An item behind a switched-off flag is never returned, so turning the flag on
 * makes its nudge appear with no app release.
 */

/** Priority order, fixed: what earns a ticket, then music, then what changes matching. */
export const PROFILE_GAP_ORDER = [
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
] as const;

export type ProfileGapKind = (typeof PROFILE_GAP_ORDER)[number];

export interface ProfileGap {
  kind: ProfileGapKind;
  /** `"ticket"` only when finishing the item really grants a free Date Ticket now. */
  reward?: "ticket";
  /** `photos` only: photos still missing to reach the bonus threshold. */
  remaining?: number;
}

export interface ProfileGapFlags {
  /** `PROFILE_VIDEO_API_ENABLED` — what `GET /v1/me/photos` reports as `videoEnabled`. */
  videoEnabled: boolean;
  /** `PROFILE_MUSIC_ENABLED` — `/v1/me/music` 404s without it. */
  musicEnabled: boolean;
  /** `VOICE_PROMPT_ENABLED` — `/v1/me/voice-prompt` 404s without it. */
  voiceEnabled: boolean;
  /** `TYPE_RADAR_ENABLED` — `/v1/radar/*` 404s without it. */
  typeRadarEnabled: boolean;
  /** `TICKET_FEATURE_ENABLED` — every ticket grant is a no-op without it. */
  ticketsEnabled: boolean;
  /**
   * Whether adding photos where the nudge leads (the app's photo editor,
   * `POST /v1/me/photos`) grants the photo bonus. See
   * `PHOTO_BONUS_GRANTED_BY_APP_UPLOAD`.
   */
  photoBonusOnAppUpload: boolean;
}

/** Everything the computation reads, already loaded. */
export interface ProfileGapSnapshot {
  major: string | null;
  age: number | null;
  preference: string | null;
  hasVoicePrompt: boolean;
  /** Pinned tracks; only read when music is enabled. */
  musicTrackCount: number;
  profile: {
    photos: string[];
    profileMedia: unknown;
    photoBonusTicketAt: Date | null;
    videoBonusTicketAt: Date | null;
    partnerPreferences: string | null;
    ageRangeMin: number | null;
    ageRangeMax: number | null;
    psychologicalSummary: string | null;
    hobbies: string[];
    typePrefTags: unknown;
  } | null;
}

/**
 * Whether the app's photo upload grants the one-time photo bonus. It does NOT
 * today: `grantPhotoBonusIfEligible` is called only from the Telegram
 * onboarding photo stage (`handlers/onboarding/conversational.ts`), never from
 * `POST /v1/me/photos` — so a nudge that promised a ticket for the sixth photo
 * would lie to everyone who sees it on Today. The `photos` item is still
 * reported (same condition as `photosForBonusTicket`), just without a reward.
 * Flip this together with wiring the grant into the native upload, which is a
 * product call for the founder (decision journal 2026-10-01).
 */
export const PHOTO_BONUS_GRANTED_BY_APP_UPLOAD = false;

/** First line of the machine stub onboarding finalize writes (current and both legacy variants). */
const ONBOARDING_STUB_PREFIX = "Profile source: onboarding answers";

/**
 * Section labels of the retired Magic Prompt import (`buildEmbeddingInput`,
 * removed 2026-09-24): the import wrote its redacted signals into the same
 * column, one `Label: …` line per section.
 */
const IMPORT_SUMMARY_LABELS = [
  "Summary",
  "Relationships",
  "Emotions and conflict",
  "Needs and boundaries",
  "Values in action",
  "Life rhythm and social energy",
  "Sustained interests",
  "Partner fit",
  "Likely friction",
  "Personality",
  "Communication",
  "Interests",
  "Values",
  "Attachment",
  "Social energy",
  "Humor",
  "Ideal partner",
  // The vibe block finalize appended to an imported summary.
  "Ideal Friday night",
  "What matters most on a night out",
];

function startsWithImportLabel(line: string): boolean {
  return IMPORT_SUMMARY_LABELS.some((label) => line.startsWith(`${label}: `));
}

/**
 * "About me" is `Profile.psychologicalSummary` on both clients — but the same
 * column is where onboarding writes its machine summary. Every finalize
 * (`saveQuestionnaireProfileAnalysis`) OVERWRITES it with
 * "Profile source: onboarding answers\nHobbies/interests: …\nPartner
 * preferences: …", and accounts from before 2026-09-24 that took the Magic
 * Prompt hold that import's `Summary: …` / `Relationships: …` lines instead.
 * Neither is text the person wrote, so neither counts as an "about".
 *
 * The import is recognised by shape: its first line and at least one more carry
 * a section label. A person who typed two such lines themselves is nudged once —
 * the cheap side of the trade.
 */
export function isAboutMissing(summary: string | null | undefined): boolean {
  const text = summary?.trim() ?? "";
  if (!text) return true;
  if (text.startsWith(ONBOARDING_STUB_PREFIX)) return true;
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const labelled = lines.filter(startsWithImportLabel).length;
  return startsWithImportLabel(lines[0]!) && labelled >= 2;
}

function isBlank(value: string | null | undefined): boolean {
  return !value?.trim();
}

/** Pure: the open items of one snapshot, in `PROFILE_GAP_ORDER`. */
export function computeProfileGaps(
  snapshot: ProfileGapSnapshot,
  flags: ProfileGapFlags,
): ProfileGap[] {
  const profile = snapshot.profile;
  const photos = profile?.photos ?? [];
  const open = new Map<ProfileGapKind, ProfileGap>();

  // video — the slot the bonus and the pitch read, whichever surface filled it.
  if (
    flags.videoEnabled &&
    !profileMediaHasVideo(normalizeProfileMedia(profile?.profileMedia ?? [], photos))
  ) {
    const bonusOpen = flags.ticketsEnabled && !profile?.videoBonusTicketAt;
    open.set("video", bonusOpen ? { kind: "video", reward: "ticket" } : { kind: "video" });
  }

  // photos — `photosForBonusTicket` in agent-insights.ts: below the threshold
  // and the bonus never claimed. Claimed then deleted down is NOT a gap.
  if (photos.length < PHOTO_BONUS_TICKET_THRESHOLD && !profile?.photoBonusTicketAt) {
    const remaining = PHOTO_BONUS_TICKET_THRESHOLD - photos.length;
    const bonusOpen = flags.ticketsEnabled && flags.photoBonusOnAppUpload;
    open.set(
      "photos",
      bonusOpen ? { kind: "photos", reward: "ticket", remaining } : { kind: "photos", remaining },
    );
  }

  if (flags.musicEnabled && snapshot.musicTrackCount === 0) open.set("music", { kind: "music" });
  if (isBlank(profile?.partnerPreferences)) open.set("looking_for", { kind: "looking_for" });
  if (profile?.ageRangeMin == null && profile?.ageRangeMax == null) {
    open.set("age_range", { kind: "age_range" });
  }
  if (isAboutMissing(profile?.psychologicalSummary)) open.set("about", { kind: "about" });
  if (!(profile?.hobbies ?? []).some((hobby) => hobby.trim())) {
    open.set("interests", { kind: "interests" });
  }
  if (flags.voiceEnabled && !snapshot.hasVoicePrompt) open.set("voice", { kind: "voice" });
  if (
    flags.typeRadarEnabled &&
    typeRadarUnavailableReason(snapshot) === null &&
    !typeRadarCalibrated(profile?.typePrefTags)
  ) {
    open.set("type_radar", { kind: "type_radar" });
  }
  if (isBlank(snapshot.major)) open.set("major", { kind: "major" });

  return PROFILE_GAP_ORDER.flatMap((kind) => {
    const gap = open.get(kind);
    return gap ? [gap] : [];
  });
}

export function profileGapFlagsFromEnv(): ProfileGapFlags {
  return {
    videoEnabled: env.PROFILE_VIDEO_API_ENABLED,
    musicEnabled: env.PROFILE_MUSIC_ENABLED,
    voiceEnabled: env.VOICE_PROMPT_ENABLED,
    typeRadarEnabled: env.TYPE_RADAR_ENABLED,
    ticketsEnabled: env.TICKET_FEATURE_ENABLED,
    photoBonusOnAppUpload: PHOTO_BONUS_GRANTED_BY_APP_UPLOAD,
  };
}

/**
 * One user lookup (profile + voice-prompt id in the same query) and, only while
 * music is on, one count. Runs on every Today refresh, so nothing else: no
 * signed URLs, no external call. Null when the user does not exist.
 */
export async function loadProfileGaps(
  userId: string,
  flags: ProfileGapFlags = profileGapFlagsFromEnv(),
): Promise<ProfileGap[] | null> {
  const [user, musicTrackCount] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: {
        major: true,
        age: true,
        preference: true,
        voicePrompt: { select: { id: true } },
        profile: {
          select: {
            photos: true,
            profileMedia: true,
            photoBonusTicketAt: true,
            videoBonusTicketAt: true,
            partnerPreferences: true,
            ageRangeMin: true,
            ageRangeMax: true,
            psychologicalSummary: true,
            hobbies: true,
            typePrefTags: true,
          },
        },
      },
    }),
    flags.musicEnabled ? countProfileMusic(userId) : Promise.resolve(0),
  ]);
  if (!user) return null;

  return computeProfileGaps(
    {
      major: user.major,
      age: user.age,
      preference: user.preference,
      hasVoicePrompt: user.voicePrompt != null,
      musicTrackCount,
      profile: user.profile,
    },
    flags,
  );
}
