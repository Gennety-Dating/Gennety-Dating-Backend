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

type Status = "loading" | "ready" | "error" | "submitting" | "done";
type Phase = "rating" | "chips";

export function App() {
  const [deck, setDeck] = useState<RadarDeck | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<RadarAnswerInput[]>([]);
  const [phase, setPhase] = useState<Phase>("rating");
  const [pending, setPending] = useState<{ photoId: string; verdict: RadarVerdict } | null>(null);

  const load = () => {
    setStatus("loading");
    fetchRadarDeck(initData)
      .then((d) => {
        setDeck(d);
        setStatus("ready");
      })
      .catch(() => setStatus("error"));
  };
  useEffect(load, []);

  const total = deck?.cards.length ?? 0;
  const promptIdx = useMemo(() => chipPromptIndices(total), [total]);
  const card = deck?.cards[index] ?? null;

  // Preload the next image so the swap feels instant.
  useEffect(() => {
    const next = deck?.cards[index + 1];
    if (next) {
      const img = new Image();
      img.src = next.image;
    }
  }, [deck, index]);

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

  const record = (answer: RadarAnswerInput) => {
    const nextAnswers = [...answers, answer];
    setAnswers(nextAnswers);
    setPhase("rating");
    setPending(null);
    if (index + 1 >= total) {
      finish(nextAnswers);
    } else {
      setIndex(index + 1);
    }
  };

  const onVerdict = (verdict: RadarVerdict) => {
    if (!card) return;
    app?.HapticFeedback?.selectionChanged?.();
    const chips = deck?.chips[card.set]?.[verdict] ?? [];
    if (promptIdx.has(index) && chips.length > 0) {
      setPending({ photoId: card.photoId, verdict });
      setPhase("chips");
    } else {
      record({ photoId: card.photoId, verdict, chipId: null });
    }
  };

  const onChip = (chipId: string | null) => {
    if (!pending) return;
    record({ photoId: pending.photoId, verdict: pending.verdict, chipId });
  };

  if (status === "loading") {
    return (
      <div className="radar-screen radar-center">
        <div className="radar-spinner" />
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

  const chips = pending ? (deck?.chips[card!.set]?.[pending.verdict] ?? []) : [];

  return (
    <div className="radar-screen">
      <header className="radar-head">
        <h1 className="radar-title">{s.title}</h1>
        <p className="radar-sub">{s.subtitle}</p>
      </header>

      <div className="radar-progress-wrap">
        <div className="radar-progress-track">
          <div
            className="radar-progress-fill"
            style={{ width: `${total ? (index / total) * 100 : 0}%` }}
          />
        </div>
        <span className="radar-progress-label">{s.progress(index, total)}</span>
      </div>

      <div className="radar-card-stack">
        {card && (
          <div
            className={`radar-card ${phase === "chips" ? "radar-card-dim" : ""}`}
            key={card.photoId}
            style={{ backgroundImage: `url(${card.image})` }}
          />
        )}

        {phase === "chips" && pending && (
          <div className="radar-chip-panel">
            <p className="radar-chip-q">{s.whyOptional}</p>
            <div className="radar-chip-row">
              {chips.map((c) => (
                <button key={c.id} className="radar-chip" onClick={() => onChip(c.id)}>
                  {s.chips[c.id] ?? c.id}
                </button>
              ))}
              <button className="radar-chip radar-chip-skip" onClick={() => onChip(null)}>
                {s.skipChip}
              </button>
            </div>
          </div>
        )}
      </div>

      {phase === "rating" && (
        <div className="radar-actions">
          <button
            className="radar-btn radar-btn-no"
            onClick={() => onVerdict("dislike")}
            aria-label={s.notMyType}
          >
            <span className="radar-btn-glyph">✕</span>
            <span className="radar-btn-label">{s.notMyType}</span>
          </button>
          <button
            className="radar-btn radar-btn-yes"
            onClick={() => onVerdict("like")}
            aria-label={s.myType}
          >
            <span className="radar-btn-glyph">♥</span>
            <span className="radar-btn-label">{s.myType}</span>
          </button>
        </div>
      )}
    </div>
  );
}
