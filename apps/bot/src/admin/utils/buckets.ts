/**
 * Bucketing helpers shared across admin analytics endpoints.
 *
 * Centralised so dashboard sections render comparable bucket boundaries
 * — if Audience age buckets drift from Gender age buckets, the user
 * loses the ability to cross-read the two charts.
 */

// ---------------------------------------------------------------------------
// Age buckets
// ---------------------------------------------------------------------------

export type AgeBucket = "18-22" | "23-27" | "28-35" | "36+" | "unknown";
export const AGE_BUCKETS: AgeBucket[] = ["18-22", "23-27", "28-35", "36+", "unknown"];

export function ageBucket(age: number | null | undefined): AgeBucket {
  if (age === null || age === undefined || !Number.isFinite(age)) return "unknown";
  if (age < 23) return "18-22";
  if (age < 28) return "23-27";
  if (age < 36) return "28-35";
  return "36+";
}

// ---------------------------------------------------------------------------
// Major → cluster
// ---------------------------------------------------------------------------

export type MajorCluster =
  | "STEM"
  | "Humanities"
  | "Arts"
  | "Business"
  | "Health"
  | "Other"
  | "Unknown";

export const MAJOR_CLUSTERS: MajorCluster[] = [
  "STEM",
  "Humanities",
  "Arts",
  "Business",
  "Health",
  "Other",
  "Unknown",
];

const CLUSTER_KEYWORDS: Record<Exclude<MajorCluster, "Unknown" | "Other">, string[]> = {
  STEM: [
    "computer", "cs ", "comp sci", "software", "engineer", "math", "physics",
    "chemistry", "biology", "data", "ai", "machine learning", "statistics",
    "robotics", "electrical", "mechanical", "civil", "informatics",
    "информатика", "програм", "матем", "инжен", "физик", "хим",
  ],
  Humanities: [
    "philosoph", "history", "literature", "linguist", "language", "philology",
    "sociology", "anthropolog", "polit", "international relations", "law",
    "филос", "истор", "литерат", "лингвист", "социолог", "право", "юрист",
  ],
  Arts: [
    "art", "design", "music", "film", "media", "theater", "theatre",
    "performance", "fashion", "architect",
    "дизайн", "музык", "искусств", "архитект",
  ],
  Business: [
    "business", "econom", "finance", "marketing", "management", "mba",
    "accounting", "entrepreneur",
    "эконом", "финанс", "маркетинг", "менеджмент", "бухгалт", "бизнес",
  ],
  Health: [
    "med", "nurs", "pharm", "dent", "health", "psycholog", "neuro",
    "медицин", "психолог", "стоматолог", "фармацевт",
  ],
};

export function majorCluster(major: string | null | undefined): MajorCluster {
  if (!major || major.trim().length === 0) return "Unknown";
  const m = major.toLowerCase();
  for (const [cluster, keywords] of Object.entries(CLUSTER_KEYWORDS)) {
    for (const kw of keywords) {
      if (m.includes(kw)) return cluster as MajorCluster;
    }
  }
  return "Other";
}

// ---------------------------------------------------------------------------
// Elo buckets
// ---------------------------------------------------------------------------

export type EloBucket = "<300" | "300-450" | "450-550" | "550-700" | ">700";
export const ELO_BUCKETS: EloBucket[] = ["<300", "300-450", "450-550", "550-700", ">700"];

export function eloBucket(elo: number): EloBucket {
  if (elo < 300) return "<300";
  if (elo < 450) return "300-450";
  if (elo < 550) return "450-550";
  if (elo < 700) return "550-700";
  return ">700";
}

// ---------------------------------------------------------------------------
// Synergy buckets — narrow because LLM clamps to 70..99
// ---------------------------------------------------------------------------

export type SynergyBucket = "70-79" | "80-89" | "90-99";
export const SYNERGY_BUCKETS: SynergyBucket[] = ["70-79", "80-89", "90-99"];

export function synergyBucket(score: number): SynergyBucket | null {
  if (score < 70 || score > 99) return null;
  if (score < 80) return "70-79";
  if (score < 90) return "80-89";
  return "90-99";
}

// ---------------------------------------------------------------------------
// Length buckets (for pitch text)
// ---------------------------------------------------------------------------

export type LengthBucket = "<200" | "200-400" | "400-600" | "600-800" | ">800";
export const LENGTH_BUCKETS: LengthBucket[] = ["<200", "200-400", "400-600", "600-800", ">800"];

export function lengthBucket(n: number): LengthBucket {
  if (n < 200) return "<200";
  if (n < 400) return "200-400";
  if (n < 600) return "400-600";
  if (n < 800) return "600-800";
  return ">800";
}

// ---------------------------------------------------------------------------
// Generic histogram
// ---------------------------------------------------------------------------

/**
 * Build a numeric histogram with `binCount` equal-width bins between
 * [min, max]. Values outside the range are clamped to the edges.
 * Returns bin labels + counts.
 */
export function histogram(
  values: number[],
  min: number,
  max: number,
  binCount: number,
): Array<{ label: string; min: number; max: number; count: number }> {
  if (binCount <= 0 || max <= min) return [];
  const width = (max - min) / binCount;
  const bins = Array.from({ length: binCount }, (_, i) => ({
    label: `${(min + i * width).toFixed(2)}-${(min + (i + 1) * width).toFixed(2)}`,
    min: min + i * width,
    max: min + (i + 1) * width,
    count: 0,
  }));
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    const clamped = Math.max(min, Math.min(max, v));
    const idx = Math.min(binCount - 1, Math.floor((clamped - min) / width));
    bins[idx]!.count++;
  }
  return bins;
}

// ---------------------------------------------------------------------------
// ISO week key (UTC) — for cohort and weekly trend grouping
// ---------------------------------------------------------------------------

/**
 * Returns "YYYY-Www" for the Monday-anchored ISO week containing `date`.
 * Used as the cohort key in retention analysis and the X-axis of weekly
 * registration / dispatch trends.
 */
export function isoWeekKey(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Median + percentiles (for wait-time / processing-time stats)
// ---------------------------------------------------------------------------

export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  if (p <= 0) return sorted[0]!;
  if (p >= 1) return sorted[sorted.length - 1]!;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

export function summarise(values: number[]): {
  n: number;
  median: number | null;
  p25: number | null;
  p75: number | null;
  mean: number | null;
} {
  if (values.length === 0) {
    return { n: 0, median: null, p25: null, p75: null, mean: null };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    n: sorted.length,
    median: percentile(sorted, 0.5),
    p25: percentile(sorted, 0.25),
    p75: percentile(sorted, 0.75),
    mean: sum / sorted.length,
  };
}
