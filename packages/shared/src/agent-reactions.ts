/**
 * Emoji reactions in the app chat with Gennety (decision 2026-11-24, spec
 * `docs/product/domains/agent-reactions.md`).
 *
 * The set is the proxy chat's five (decision 2026-09-08), shared so both chats
 * offer the same emoji. Stored Telegram-canonical: `❤` WITHOUT the variation
 * selector U+FE0F — the string Telegram's reaction list holds. A client may
 * send the red `❤️`; {@link normalizeReactionEmoji} folds it to `❤`.
 */
export const REACTION_EMOJI = ["❤", "👍", "🔥", "🤣", "🙏"] as const;
export type ReactionEmoji = (typeof REACTION_EMOJI)[number];

export function isReactionEmoji(value: string): value is ReactionEmoji {
  return (REACTION_EMOJI as readonly string[]).includes(value);
}

/** The emoji in the closed set, with `❤️` folded to `❤`; null for anything else. */
export function normalizeReactionEmoji(raw: string): ReactionEmoji | null {
  const folded = raw.trim().replace(/\uFE0F/g, "");
  return isReactionEmoji(folded) ? folded : null;
}

/** The `X-Gennety-Chat-Cards` token of a build that draws reactions. */
export const AGENT_REACTIONS_CLIENT_TOKEN = "reactions";

/**
 * Why Gennety may react this turn. Step 1 has one occasion: the person closed
 * the topic («ок, спасибо», «понял», 👍) and nothing is owed. Step 2 (photos,
 * good news) adds occasions here and leaves the guard as it is.
 */
export type AgentReactionOccasion = "closing";

/** Limits of Gennety's own reactions, enforced by the server. */
export const AGENT_REACTIONS = {
  /** At most one Gennety reaction among this many of the person's messages, this one included. */
  everyUserMessages: 5,
  /** How many of the person's newest messages the sensitive-words check reads. */
  safetyLookback: 6,
  /** A closing message longer than this is a message, not a closing. */
  closingMaxChars: 40,
  /** Characters of the reacted reply quoted in the next turn's prompt line. */
  excerptChars: 60,
  /** The emoji each occasion allows. 🤣 is never on a photo or on what they tell about themselves. */
  occasionEmoji: {
    closing: ["🙏", "👍", "❤"],
  } as Record<AgentReactionOccasion, readonly ReactionEmoji[]>,
} as const;

/**
 * Emoji a whole message may consist of and still be a closing («👍», «🙏🙏»).
 * Compared with the variation selector folded away.
 */
export const CLOSING_EMOJI: readonly string[] = ["👍", "🙏", "❤", "👌", "🤝", "✅", "😊", "🙂", "💪", "🫡", "😌", "🥰", "💜", "💙", "🤗"];

/**
 * Words after which Gennety never reacts, in any supported language: sadness,
 * anxiety, a complaint, a cancelled date, danger. A closing «ок, спасибо» at the
 * end of such a talk deserves words, not an emoji. `*` marks a stem. Read over
 * the person's newest {@link AGENT_REACTIONS.safetyLookback} messages.
 */
export const AGENT_REACTION_SENSITIVE_TERMS: readonly string[] = [
  // ru
  "груст*", "печал*", "плохо", "хуже", "плач*", "слез*", "одинок*", "тревож*", "тревог*", "боюсь", "страшно",
  "паник*", "депресс*", "устал от", "устала от", "больно", "обид*", "жалоб*", "жалуюсь", "жалова*", "пожалова*", "ужасн*", "отвратительн*",
  "бесит", "разочаров*", "отмен*", "не приду", "не пришел", "не пришла", "не пришёл", "кинул*", "продинамил*",
  "помогите", "помоги мне", "опасн*", "угрож*", "преслед*", "напал*", "полици*", "скорую", "умер*", "смерт*",
  "похорон*", "самоуб*", "суицид*", "не хочу жить", "расстал*", "бросил*", "развод*", "болею", "болезн*",
  "больниц*", "уволил*",
  // uk
  "сумн*", "сумую", "скарг*", "поскарж*", "погано", "плачу", "самотн*", "тривож*", "страшно", "боюся", "скасу*", "скасува*",
  "не прийду", "не прийшов", "не прийшла", "допоможіть", "небезпе*", "погрож*", "поліці*", "помер*", "смерть",
  "розлуч*", "розійшл*", "лікарн*", "хворі*",
  // en
  "sad", "upset", "depress*", "lonely", "crying", "cried", "anxious", "anxiety", "panic*", "scared", "afraid",
  "worried", "hurt", "terrible", "awful", "complain*", "disappoint*", "annoyed", "angry", "cancel*",
  "stood me up", "didn't show", "did not show", "no-show", "help me", "danger*", "threat*", "stalk*", "attack*",
  "police", "ambulance", "emergency", "died", "death", "funeral", "suicid*", "kill myself", "broke up",
  "breakup", "divorce*", "hospital", "sick", "fired",
  // de
  "traurig", "einsam", "angst", "ängstlich", "panik", "schlimm", "schrecklich", "beschwer*", "enttäusch*",
  "abgesagt", "absagen", "hilfe", "gefahr", "gefährlich", "bedroh*", "polizei", "notfall", "gestorben", "tod",
  "selbstmord", "getrennt", "trennung", "krankenhaus", "krank",
  // pl
  "smutn*", "samotn*", "płacz*", "lęk*", "boję się", "strach", "panik*", "okropn*", "skarg*", "rozczarow*",
  "odwoł*", "anulow*", "pomocy", "niebezpiecz*", "grozi*", "policj*", "pogotowi*", "zmarł*", "śmierć",
  "samobój*", "rozstal*", "rozwód", "szpital*", "chor*",
];

function termPattern(term: string): RegExp {
  const stem = term.endsWith("*");
  const body = (stem ? term.slice(0, -1) : term).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+");
  // Unicode-aware word edges: Cyrillic letters are not \w.
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}${stem ? "" : "(?![\\p{L}\\p{N}])"}`, "iu");
}

const SENSITIVE_PATTERNS = AGENT_REACTION_SENSITIVE_TERMS.map(termPattern);

/** True when any of these messages reads as sad, anxious, a complaint, a cancellation or danger. */
export function agentReactionSensitiveHit(texts: readonly string[]): boolean {
  return texts.some((text) => {
    const lower = text.toLowerCase().replace(/ё/g, "е");
    return SENSITIVE_PATTERNS.some((re) => re.test(lower) || re.test(text.toLowerCase()));
  });
}
