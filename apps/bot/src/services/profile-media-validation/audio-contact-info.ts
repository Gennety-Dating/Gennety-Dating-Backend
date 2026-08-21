/**
 * Does this transcript hand out a way to contact the speaker off-platform?
 *
 * A rule that exists only because the medium is audio. NO IN-APP CHAT is a core
 * product principle (PRODUCT_SPEC §Core Principles) with exactly one narrow,
 * flag-gated carve-out, and every other profile surface enforces it
 * structurally: a photo cannot dictate a phone number, a bio is short and
 * read by a moderator's eye. A voice prompt plays to a stranger before they
 * decide, and thirty seconds is plenty of room to say "just write to me on
 * Instagram" — which routes the whole match around the product.
 *
 * Deterministic, not an LLM call, for the same reason `isProfilerRefusal` is:
 * it runs on every recording, and the failure modes are asymmetric. A missed
 * detection degrades to the status quo (a moderator can still see the
 * transcript), while a false positive throws away a real recording someone
 * just made and tells them they broke a rule they did not break.
 *
 * That asymmetry is the whole design of the predicate below. A bare platform
 * name is NOT enough — "я работаю в инстаграме", "we met on Telegram" are
 * ordinary things to say about your life. What triggers is either
 *
 *   (a) an actual contact token — a handle, a link, or a long digit run, which
 *       is not something you say by accident; or
 *   (b) a platform name AND an invitation to write there.
 *
 * Whisper transcribes speech, so a dictated handle usually arrives as "@name"
 * or as the platform plus a name; both shapes are covered.
 */

/**
 * Unicode-aware word boundaries.
 *
 * `\b` is ASCII-only in JavaScript — it is defined on `\w`, which does not
 * include Cyrillic — so `/\bинстаграм\b/u` silently fails to match "в
 * инстаграме". Four of the five languages here are affected, i.e. the naive
 * version would have shipped a rule that only worked in English. These
 * lookarounds are the fix, and the trailing `\p{L}{0,4}` in `stems()` is the
 * other half: Slavic inflection means the stem almost never appears bare.
 */
const OPEN = "(?<![\\p{L}\\p{N}])";
const CLOSE = "(?![\\p{L}\\p{N}])";

function stems(...roots: readonly string[]): RegExp {
  return new RegExp(`${OPEN}(?:${roots.join("|")})\\p{L}{0,4}${CLOSE}`, "iu");
}

/** `@handle` — four or more characters, so "@" alone or "@a" is not a hit. */
const HANDLE = /@[a-z0-9_.]{4,}/iu;

/** Any link at all. A voice prompt has no legitimate reason to carry one. */
const LINK = /(?:https?:\/\/|www\.|t\.me\/|wa\.me\/|instagram\.com|telegram\.me)/iu;

/**
 * Seven or more digits in a row, ignoring the separators speech-to-text likes
 * to insert. Seven is the shortest real subscriber number; six would start
 * catching years, prices and street numbers read aloud.
 */
const DIGIT_RUN = /(?:\d[\s\-().]*){7,}/u;

/** Platform names, including how Whisper renders them in each locale. */
const PLATFORM = stems(
  "instagram",
  "инстаграм",
  "инста",
  "інстаграм",
  "телеграм",
  "telegram",
  "телега",
  "whatsapp",
  "вотсап",
  "ватсап",
  "viber",
  "вайбер",
  "snapchat",
  "снапчат",
  "tiktok",
  "тикток",
  "тікток",
  "facebook",
  "фейсбук",
);

/**
 * An invitation to make contact there. Deliberately verbs of WRITING and
 * FINDING rather than of mentioning — "я видел это в инстаграме" must pass.
 */
const INVITE = stems(
  "напиш",
  "пиши",
  "пишит",
  "найд",
  "шука",
  "знайд",
  "додай",
  "добав",
  "подпиш",
  "підпиш",
  "скинь",
  "write",
  "text",
  "message",
  "dm",
  "add me",
  "find me",
  "follow me",
  "reach me",
  "schreib",
  "napisz",
  "znajdz",
  "znajdź",
  "dodaj",
);

export function transcriptSharesContactInfo(transcript: string): boolean {
  const text = transcript.trim();
  if (!text) return false;

  if (HANDLE.test(text)) return true;
  if (LINK.test(text)) return true;
  if (DIGIT_RUN.test(text)) return true;

  return PLATFORM.test(text) && INVITE.test(text);
}
