/**
 * Keyword scanners over `Profile.psychologicalSummary` text — extracts
 * coarse psychological dimensions without an LLM call.
 *
 * Why keyword scan instead of structured columns: the LLM already wrote
 * these dimensions into `psychologicalSummary` during onboarding; storing
 * them again as columns would require a backfill + ongoing dual-write.
 * For analytics aggregates (where ±5% accuracy is fine) keyword matching
 * is good enough and free.
 *
 * If accuracy ever matters per-user (e.g. surfacing the trait on the
 * profile screen), promote these to columns + run a one-time backfill.
 */

const RX_LITERAL_SAFE = /[.*+?^${}()|[\]\\]/g;

function tokenize(text: string | null | undefined): string {
  return (text ?? "").toLowerCase();
}

function anyMatch(haystack: string, needles: readonly string[]): boolean {
  for (const n of needles) {
    if (haystack.includes(n)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Social energy: introvert / extrovert / ambivert
// ---------------------------------------------------------------------------

export type SocialEnergy = "introvert" | "extrovert" | "ambivert" | "unknown";
export const SOCIAL_ENERGY_VALUES: SocialEnergy[] = [
  "introvert",
  "extrovert",
  "ambivert",
  "unknown",
];

export function detectSocialEnergy(summary: string | null | undefined): SocialEnergy {
  const s = tokenize(summary);
  if (!s) return "unknown";
  // ambivert first — "ambivert" contains neither "introvert" nor "extrovert"
  if (s.includes("ambivert") || s.includes("амбиверт")) return "ambivert";
  if (s.includes("introvert") || s.includes("интроверт")) return "introvert";
  if (s.includes("extrovert") || s.includes("экстраверт")) return "extrovert";
  return "unknown";
}

// ---------------------------------------------------------------------------
// Attachment style: secure / anxious / avoidant / disorganized
// ---------------------------------------------------------------------------

export type AttachmentStyle =
  | "secure"
  | "anxious"
  | "avoidant"
  | "disorganized"
  | "unknown";
export const ATTACHMENT_STYLE_VALUES: AttachmentStyle[] = [
  "secure",
  "anxious",
  "avoidant",
  "disorganized",
  "unknown",
];

const ATTACHMENT_KEYWORDS: Record<Exclude<AttachmentStyle, "unknown">, readonly string[]> = {
  secure: ["secure attachment", "securely attached", "надёжн", "надежн"],
  anxious: ["anxious attachment", "anxiously", "тревожн"],
  avoidant: ["avoidant", "dismissive-avoidant", "избегающ"],
  disorganized: ["disorganized", "fearful-avoidant", "дезорганизован"],
};

export function detectAttachmentStyle(summary: string | null | undefined): AttachmentStyle {
  const s = tokenize(summary);
  if (!s) return "unknown";
  for (const [style, keywords] of Object.entries(ATTACHMENT_KEYWORDS)) {
    if (anyMatch(s, keywords)) return style as AttachmentStyle;
  }
  return "unknown";
}

// ---------------------------------------------------------------------------
// Humor style: dry / playful / sarcastic / wholesome / dark
// ---------------------------------------------------------------------------

export type HumorStyle =
  | "dry"
  | "playful"
  | "sarcastic"
  | "wholesome"
  | "dark"
  | "unknown";
export const HUMOR_STYLE_VALUES: HumorStyle[] = [
  "dry",
  "playful",
  "sarcastic",
  "wholesome",
  "dark",
  "unknown",
];

const HUMOR_KEYWORDS: Record<Exclude<HumorStyle, "unknown">, readonly string[]> = {
  dry: ["dry humor", "deadpan", "сухой юмор"],
  playful: ["playful", "witty", "lighthearted", "игрив", "лёгк"],
  sarcastic: ["sarcastic", "sarcasm", "ironic", "саркаст", "ирон"],
  wholesome: ["wholesome", "warm humor", "добр"],
  dark: ["dark humor", "morbid", "тёмн", "чёрн"],
};

export function detectHumorStyle(summary: string | null | undefined): HumorStyle {
  const s = tokenize(summary);
  if (!s) return "unknown";
  for (const [style, keywords] of Object.entries(HUMOR_KEYWORDS)) {
    if (anyMatch(s, keywords)) return style as HumorStyle;
  }
  return "unknown";
}

// ---------------------------------------------------------------------------
// Communication style: direct / diplomatic / expressive / reserved
// ---------------------------------------------------------------------------

export type CommunicationStyle =
  | "direct"
  | "diplomatic"
  | "expressive"
  | "reserved"
  | "unknown";
export const COMMUNICATION_STYLE_VALUES: CommunicationStyle[] = [
  "direct",
  "diplomatic",
  "expressive",
  "reserved",
  "unknown",
];

const COMMUNICATION_KEYWORDS: Record<Exclude<CommunicationStyle, "unknown">, readonly string[]> = {
  direct: ["direct communicator", "blunt", "straightforward", "прям"],
  diplomatic: ["diplomatic", "tactful", "дипломат"],
  expressive: ["expressive", "animated", "emotive", "эмоционал"],
  reserved: ["reserved", "soft-spoken", "quiet", "сдержан"],
};

export function detectCommunicationStyle(
  summary: string | null | undefined,
): CommunicationStyle {
  const s = tokenize(summary);
  if (!s) return "unknown";
  for (const [style, keywords] of Object.entries(COMMUNICATION_KEYWORDS)) {
    if (anyMatch(s, keywords)) return style as CommunicationStyle;
  }
  return "unknown";
}

// ---------------------------------------------------------------------------
// Feedback sentiment (post-date) — coarse 3-bucket via keyword
// ---------------------------------------------------------------------------

export type FeedbackSentiment = "positive" | "neutral" | "negative" | "unknown";
export const FEEDBACK_SENTIMENT_VALUES: FeedbackSentiment[] = [
  "positive",
  "neutral",
  "negative",
  "unknown",
];

const POSITIVE_KEYWORDS = [
  "great", "amazing", "loved", "wonderful", "fun", "spark", "chemistry",
  "fantastic", "good time", "клёво", "класс", "понрав", "отличн", "супер",
];
const NEGATIVE_KEYWORDS = [
  "awkward", "boring", "ghost", "ghosted", "bad", "terrible", "no spark",
  "rude", "uncomfortable", "worst", "ужасн", "плох", "скучн", "стрем",
];

export function detectFeedbackSentiment(
  feedback: string | null | undefined,
): FeedbackSentiment {
  const s = tokenize(feedback);
  if (!s || s.trim().length === 0) return "unknown";
  const hasPositive = anyMatch(s, POSITIVE_KEYWORDS);
  const hasNegative = anyMatch(s, NEGATIVE_KEYWORDS);
  if (hasPositive && !hasNegative) return "positive";
  if (hasNegative && !hasPositive) return "negative";
  if (hasPositive && hasNegative) return "neutral";
  return "neutral";
}

// ---------------------------------------------------------------------------
// Word frequency (for rejection reasons)
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  "the", "a", "an", "of", "to", "and", "or", "but", "is", "was", "are", "were",
  "in", "on", "at", "for", "with", "by", "as", "it", "this", "that", "i", "we",
  "you", "they", "he", "she", "his", "her", "their", "our", "my", "me", "us",
  "them", "him", "do", "does", "did", "be", "been", "being", "have", "has", "had",
  "не", "и", "в", "на", "с", "по", "для", "из", "от", "к", "о", "об", "у",
  "это", "его", "её", "их", "мне", "ему", "ей", "что", "как", "так", "же",
  "ещё", "только", "тоже", "очень", "просто",
]);

export function wordFrequency(
  texts: Array<string | null | undefined>,
  topN: number = 30,
): Array<{ word: string; count: number }> {
  const counts = new Map<string, number>();
  for (const text of texts) {
    if (!text) continue;
    const words = text
      .toLowerCase()
      .replace(new RegExp(RX_LITERAL_SAFE, "g"), " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
    for (const w of words) {
      counts.set(w, (counts.get(w) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .map(([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, topN);
}
