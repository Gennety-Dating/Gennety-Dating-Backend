import { useEffect, useMemo, useState } from "react";
import {
  fetchRadarDeck,
  submitRadar,
  type RadarDeck,
  type RadarAnswerInput,
  type RadarVerdict,
} from "../api.js";
import { pickLang } from "../i18n.js";
import { radarStrings } from "./i18n.js";

const app = window.Telegram?.WebApp;
const params = new URLSearchParams(location.search);
const lang = pickLang(params.get("lang") ?? app?.initDataUnsafe?.user?.language_code ?? null);
const s = radarStrings(lang);
const initData = app?.initData ?? "";

/** Cards on which we surface the optional "why?" reason chips. Kept to ≤4 and
 *  front-loaded (first two verdicts + two spaced later) so a one-tap detail is
 *  offered without turning every card into two taps. */
function chipPromptIndices(total: number): Set<number> {
  const idx = new Set<number>();
  for (const i of [0, 1, Math.floor(total / 2), total - 2]) {
    if (i >= 0 && i < total) idx.add(i);
  }
  return idx;
}

/** How many leading cards must be paint-ready before we reveal the rating UI.
 *  Just the current + next: enough to start instantly and land on card 2 with
 *  no flash, while the rest keep preloading in the background. */
const HEAD_READY = 2;
/** Parallel image fetches. Small enough to stay polite on a phone connection,
 *  large enough to race ahead of a user rating one card every ~1–2s. */
const PRELOAD_CONCURRENCY = 4;

/** How long the card's fly-off animation runs before we advance to the next
 *  one. Kept in sync with the `radar-card-out-*` keyframe duration in the CSS. */
const EXIT_MS = 260;

/** Load + decode one image; resolves paint-ready (or on error, so the ordered
 *  queue never stalls on a single bad asset). */
function preloadOne(url: string): Promise<void> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve();
    img.onerror = () => resolve();
    img.src = url;
    // decode() (when supported) guarantees the bytes are decoded and ready to
    // paint, so the later background-image swap is instant, not a re-decode.
    void img.decode?.().then(() => resolve()).catch(() => {});
  });
}

/** Preload `urls` in order with bounded concurrency, calling `onReady(index)`
 *  as each becomes paint-ready. `cancelled()` lets an unmounted deck bail. */
function preloadOrdered(
  urls: string[],
  concurrency: number,
  onReady: (index: number) => void,
  cancelled: () => boolean,
): void {
  let next = 0;
  const pump = (): void => {
    if (cancelled()) return;
    const idx = next++;
    if (idx >= urls.length) return;
    void preloadOne(urls[idx]!).then(() => {
      if (cancelled()) return;
      onReady(idx);
      pump();
    });
  };
  for (let k = 0; k < Math.min(concurrency, urls.length); k++) pump();
}

type Status = "loading" | "ready" | "error" | "submitting" | "done";
type Phase = "rating" | "chips";

export function App() {
  const [deck, setDeck] = useState<RadarDeck | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<RadarAnswerInput[]>([]);
  const [phase, setPhase] = useState<Phase>("rating");
  const [pending, setPending] = useState<{ photoId: string; verdict: RadarVerdict } | null>(null);
  // Non-null while the current card is playing its fly-off animation; also a
  // re-entrancy guard so a double-tap mid-exit can't record two answers.
  const [exiting, setExiting] = useState<RadarVerdict | null>(null);
  // Indices whose card image is fully decoded and instant to paint.
  const [ready, setReady] = useState<Set<number>>(new Set());

  const load = () => {
    setStatus("loading");
    setReady(new Set());
    fetchRadarDeck(initData)
      .then((d) => setDeck(d))
      .catch(() => setStatus("error"));
  };
  useEffect(load, []);

  const total = deck?.cards.length ?? 0;
  const promptIdx = useMemo(() => chipPromptIndices(total), [total]);
  const card = deck?.cards[index] ?? null;

  // Once the deck arrives, preload every card image in swipe order in the
  // background so listing never waits on a network fetch. We reveal the rating
  // UI as soon as the first HEAD_READY images are paint-ready (below), while the
  // rest keep streaming into the browser cache ahead of the user.
  useEffect(() => {
    if (!deck) return;
    let cancelled = false;
    preloadOrdered(
      deck.cards.map((c) => c.image),
      PRELOAD_CONCURRENCY,
      (idx) => setReady((prev) => new Set(prev).add(idx)),
      () => cancelled,
    );
    return () => {
      cancelled = true;
    };
  }, [deck]);

  // Reveal the deck the moment the leading cards are decoded — not after all of
  // them — so the picker starts fast even on a slow connection.
  const headReady =
    total > 0 &&
    Array.from({ length: Math.min(HEAD_READY, total) }, (_, i) => i).every((i) => ready.has(i));
  useEffect(() => {
    if (status === "loading" && deck && headReady) setStatus("ready");
  }, [status, deck, headReady]);

  const finish = (finalAnswers: RadarAnswerInput[]) => {
    setStatus("submitting");
    submitRadar(initData, finalAnswers)
      .then(() => {
        setStatus("done");
        app?.HapticFeedback?.notificationOccurred?.("success");
        setTimeout(() => app?.close?.(), 600);
      })
      // A failed save shouldn't trap the user mid-onboarding — close and let
      // the bot's Skip path continue the flow (V_type just stays neutral).
      .catch(() => {
        setStatus("done");
        setTimeout(() => app?.close?.(), 600);
      });
  };

  const advance = (finalAnswers: RadarAnswerInput[]) => {
    setPhase("rating");
    setPending(null);
    if (index + 1 >= total) {
      finish(finalAnswers);
    } else {
      setIndex(index + 1);
    }
  };

  // `animate` plays the card's fly-off before advancing (the fast, no-chip
  // verdict path); the reason-chip path advances straight to the next card,
  // whose own entrance animation carries the motion.
  const record = (answer: RadarAnswerInput, animate = true) => {
    const nextAnswers = [...answers, answer];
    setAnswers(nextAnswers);
    if (animate) {
      setExiting(answer.verdict);
      window.setTimeout(() => {
        setExiting(null);
        advance(nextAnswers);
      }, EXIT_MS);
    } else {
      advance(nextAnswers);
    }
  };

  const onVerdict = (verdict: RadarVerdict) => {
    if (!card || exiting) return;
    app?.HapticFeedback?.selectionChanged?.();
    const chips = card.chips?.[verdict] ?? [];
    if (promptIdx.has(index) && chips.length > 0) {
      setPending({ photoId: card.photoId, verdict });
      setPhase("chips");
    } else {
      record({ photoId: card.photoId, verdict, chipId: null });
    }
  };

  const onChip = (chipId: string | null) => {
    if (!pending || exiting) return;
    record({ photoId: pending.photoId, verdict: pending.verdict, chipId }, false);
  };

  if (status === "loading") {
    // Render the exact same markup as the static shell in radar.html (shared
    // inline `.boot` CSS), so React taking over the #root is a seamless, jump-
    // free handoff while the deck + first images warm up.
    return (
      <div className="boot">
        <div className="boot-stack">
          <span className="boot-ghost g3" />
          <span className="boot-ghost g2" />
          <span className="boot-ghost g1" />
        </div>
        <div className="boot-bar">
          <span />
        </div>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="radar-screen radar-center">
        <p className="radar-error">{s.loadError}</p>
        <button className="radar-btn radar-btn-ghost" onClick={load}>
          {s.retry}
        </button>
      </div>
    );
  }

  if (status === "submitting" || status === "done") {
    return (
      <div className="radar-screen radar-center">
        <div className="radar-spinner" />
        <p className="radar-finishing">{s.finishing}</p>
      </div>
    );
  }

  const chips = pending ? (card?.chips?.[pending.verdict] ?? []) : [];

  const cardClass = [
    "radar-card",
    phase === "chips" ? "radar-card-dim" : "",
    exiting === "like" ? "radar-card-out-right" : exiting === "dislike" ? "radar-card-out-left" : "",
    ready.has(index) ? "" : "radar-card-loading",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="radar-screen">
      <header className="radar-head">
        <h1 className="radar-title">{s.title}</h1>
      </header>

      <div className="radar-progress-track">
        <div
          className="radar-progress-fill"
          style={{ width: `${total ? (index / total) * 100 : 0}%` }}
        />
      </div>

      <div className="radar-card-stack">
        {card && (
          <div
            className={cardClass}
            key={card.photoId}
            style={ready.has(index) ? { backgroundImage: `url(${card.image})` } : undefined}
          />
        )}
        <div className="radar-card-scrim" aria-hidden="true" />

        {phase === "chips" && pending && (
          <div className="radar-chip-panel">
            <p className="radar-chip-q">{s.whyOptional}</p>
            <div className="radar-chip-row">
              {chips.map((c) => (
                <button key={c.id} className="radar-glass radar-chip" onClick={() => onChip(c.id)}>
                  {s.chips[c.id] ?? c.id}
                </button>
              ))}
              <button className="radar-chip radar-chip-skip" onClick={() => onChip(null)}>
                {s.skipChip}
              </button>
            </div>
          </div>
        )}

        {phase === "rating" && card && (
          <div className="radar-actions">
            <button
              className="radar-btn radar-btn-no"
              onClick={() => onVerdict("dislike")}
              aria-label={s.notMyType}
            >
              <span className="radar-glass radar-btn-glyph">✕</span>
              <span className="radar-btn-label">{s.notMyType}</span>
            </button>
            <button
              className="radar-btn radar-btn-yes"
              onClick={() => onVerdict("like")}
              aria-label={s.myType}
            >
              <span className="radar-glass radar-btn-glyph">♥</span>
              <span className="radar-btn-label">{s.myType}</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
