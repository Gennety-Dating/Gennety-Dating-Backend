import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import {
  fetchTicketState,
  createTicketIntent,
  confirmTicketPayment,
  useTicketFromWallet,
  CalendarApiError,
  type TicketState,
  type TicketIntent,
  type TicketScope,
} from "../api.js";
import { pickLang, strings, fill, type TicketStrings } from "./i18n.js";
import {
  deriveScreen,
  deriveOfferButtons,
  deriveCoverPartnerButtons,
  formatUsd,
  type TicketScreen,
  type OfferButton,
} from "./ticket-state.js";
import { Ticket3D } from "./Ticket3D.js";
import { MockPayment } from "./MockPayment.js";
import { Confetti } from "./Confetti.js";
import { PartialTimer } from "./PartialTimer.js";
import { PartnerPaidCard } from "./PartnerPaidCard.js";

const app = window.Telegram?.WebApp;
const params = new URLSearchParams(location.search);
const matchId = params.get("match") ?? "";
const lang = pickLang(params.get("lang") ?? app?.initDataUnsafe?.user?.language_code ?? null);
const initData = app?.initData ?? "";
document.documentElement?.setAttribute("lang", lang);

type Phase =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "view"; state: TicketState }
  | { kind: "mock"; state: TicketState; scope: TicketScope; intent: TicketIntent; processing: boolean };

function haptic(type: "light" | "success" | "error"): void {
  const h = app?.HapticFeedback;
  if (!h) return;
  if (type === "light") h.impactOccurred("light");
  else h.notificationOccurred(type);
}

function goToScheduling(): void {
  // Same-origin webapp bundle — reopen the Calendar Mini App in this WebView.
  location.href = `index.html?match=${encodeURIComponent(matchId)}&lang=${lang}`;
}

export function App(): ReactElement {
  const s = strings(lang);
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const myName = app?.initDataUnsafe?.user?.first_name ?? s.youFallback;

  // Ref to the latest phase so imperative MainButton handlers read fresh values.
  const phaseRef = useRef<Phase>(phase);
  phaseRef.current = phase;

  const load = useCallback(async (): Promise<void> => {
    try {
      const state = await fetchTicketState(initData, matchId);
      setPhase({ kind: "view", state });
    } catch (err) {
      setPhase({ kind: "error", message: errorText(err, s) });
    }
  }, [s]);

  // Initial load.
  useEffect(() => {
    if (!matchId || !initData) {
      setPhase({ kind: "error", message: s.errGeneric });
      return;
    }
    void load();
  }, [load, s.errGeneric]);

  // Poll while waiting on the partner so partner-payment / refund transitions
  // land without the user reopening the Mini App.
  const screen: TicketScreen | null = phase.kind === "view" ? deriveScreen(phase.state) : null;
  useEffect(() => {
    // Poll while waiting on the partner (also on the male's "cover-partner"
    // screen, where the partner may pay herself in the meantime).
    if (screen !== "waiting" && screen !== "cover-partner") return;
    const id = setInterval(() => void load(), 4000);
    return () => clearInterval(id);
  }, [screen, load]);

  // ── Payment actions ──────────────────────────────────────────────────────
  const startPayment = useCallback(
    async (state: TicketState, scope: TicketScope): Promise<void> => {
      haptic("light");
      try {
        const intent = await createTicketIntent(initData, matchId, scope);
        setPhase({ kind: "mock", state, scope, intent, processing: false });
      } catch (err) {
        app?.showAlert(errorText(err, s));
      }
    },
    [s],
  );

  // Spend a wallet ticket (no payment screen) — settles the gate immediately.
  const spendTicket = useCallback(
    async (scope: TicketScope): Promise<void> => {
      haptic("light");
      try {
        const next = await useTicketFromWallet(initData, matchId, scope);
        haptic("success");
        setPhase({ kind: "view", state: next });
      } catch (err) {
        haptic("error");
        app?.showAlert(errorText(err, s));
      }
    },
    [s],
  );

  // Male "cover both" holding exactly one wallet ticket: spend it on his own
  // slot, then open the single-price ($6.99) payment for the partner's slot —
  // 🎫 + one ticket's money, never the doubled "pay for both". If the partner
  // settled concurrently we just show the refreshed (cover-partner/success)
  // screen instead of a redundant charge.
  const useSelfThenPayPartner = useCallback(async (): Promise<void> => {
    haptic("light");
    try {
      const next = await useTicketFromWallet(initData, matchId, "self");
      if (!next.bothPaid && next.iPaid && !next.partnerPaid) {
        const intent = await createTicketIntent(initData, matchId, "partner");
        setPhase({ kind: "mock", state: next, scope: "partner", intent, processing: false });
      } else {
        haptic("success");
        setPhase({ kind: "view", state: next });
      }
    } catch (err) {
      haptic("error");
      app?.showAlert(errorText(err, s));
      void load();
    }
  }, [s, load]);

  const onOfferButton = useCallback(
    (state: TicketState, b: OfferButton): void => {
      if (b.action === "use") void spendTicket(b.scope);
      else if (b.action === "use-self-pay-partner") void useSelfThenPayPartner();
      else void startPayment(state, b.scope);
    },
    [spendTicket, startPayment, useSelfThenPayPartner],
  );

  const completePayment = useCallback(async (): Promise<void> => {
    setPhase((p) => (p.kind === "mock" ? { ...p, processing: true } : p));
    const current = phaseRef.current;
    if (current.kind !== "mock") return;
    try {
      const next = await confirmTicketPayment(initData, matchId, current.scope, current.intent.clientSecret);
      haptic("success");
      setPhase({ kind: "view", state: next });
    } catch (err) {
      haptic("error");
      app?.showAlert(errorText(err, s));
      setPhase((p) => (p.kind === "mock" ? { ...p, processing: false } : p));
    }
  }, [s]);

  // No Telegram MainButton/BackButton — we render our own buttons fixed to the
  // bottom of the full-screen web app (see the .action-bar footers below).

  // ── Render ───────────────────────────────────────────────────────────────
  if (phase.kind === "loading") {
    return <div className="ticket-page ticket-center"><div className="spinner" /><p>{s.loading}</p></div>;
  }
  if (phase.kind === "error") {
    return <div className="ticket-page ticket-center"><p className="ticket-error">{phase.message}</p></div>;
  }
  if (phase.kind === "mock") {
    const amount = formatUsd(phase.intent.amountCents);
    return (
      <div className="ticket-page has-bar">
        <div className="ticket-scroll">
          <MockPayment amountCents={phase.intent.amountCents} strings={s} />
        </div>
        <footer className="action-bar">
          <button
            type="button"
            className="btn-primary"
            disabled={phase.processing}
            onClick={() => void completePayment()}
          >
            {phase.processing ? s.processing : fill(s.mockPayNow, { amount })}
          </button>
          <button
            type="button"
            className="btn-text"
            disabled={phase.processing}
            onClick={() => setPhase({ kind: "view", state: phase.state })}
          >
            {s.back}
          </button>
        </footer>
      </div>
    );
  }

  const state = phase.state;
  const sc = deriveScreen(state);

  return (
    <div className="ticket-page has-bar">
      {sc === "success" && <Confetti />}
      <div className="ticket-scroll">
        {sc === "partner-paid" ? (
          <PartnerPaidCard partnerName={state.partnerName ?? s.matchFallback} strings={s} />
        ) : (
          <>
            <header className="ticket-header">
              <h1>{headerTitle(sc, state, s)}</h1>
              <p>{headerSub(sc, state, s)}</p>
            </header>

            <Ticket3D myName={myName} partnerName={state.partnerName} strings={s} />

            {(sc === "offer" || sc === "cover-partner") && state.myBalance > 0 && (
              <p className="ticket-balance-note">{fill(s.balanceNote, { n: String(state.myBalance) })}</p>
            )}

            {(sc === "waiting" || sc === "cover-partner") && (
              <PartialTimer expiresAt={state.expiresAt} template={s.waitingTimer} />
            )}
          </>
        )}
      </div>

      <footer className="action-bar">
        {sc === "offer" &&
          deriveOfferButtons(state).map((b) => {
            const discounted =
              b.action === "pay" && b.scope === "self" && state.selfDiscountPct > 0;
            return (
              <button
                key={`${b.action}:${b.scope}`}
                type="button"
                className={`${b.primary ? "btn-primary" : "btn-secondary"}${discounted ? " btn-famine" : ""}`}
                onClick={() => onOfferButton(state, b)}
              >
                {discounted && (
                  <span className="ticket-famine-badge">
                    {fill(s.famineBadge, { pct: String(state.selfDiscountPct) })}
                  </span>
                )}
                {offerLabel(b, state, s)}
              </button>
            );
          })}

        {sc === "cover-partner" && (
          <>
            {deriveCoverPartnerButtons(state).map((b) => (
              <button
                key={`${b.action}:${b.scope}`}
                type="button"
                className={b.primary ? "btn-primary" : "btn-secondary"}
                onClick={() => onOfferButton(state, b)}
              >
                {offerLabel(b, state, s)}
              </button>
            ))}
            <button type="button" className="btn-text" onClick={() => app?.close()}>
              {s.justWait}
            </button>
          </>
        )}

        {(sc === "success" || sc === "partner-paid" || sc === "closed") && (
          <button type="button" className="btn-primary" onClick={goToScheduling}>
            {s.goToScheduling}
          </button>
        )}

        {sc === "waiting" && (
          <button type="button" className="btn-secondary" onClick={() => app?.close()}>
            {s.close}
          </button>
        )}
      </footer>
    </div>
  );
}

function offerLabel(b: OfferButton, state: TicketState, s: TicketStrings): string {
  if (b.action === "use") {
    if (b.scope === "both") return s.useBoth;
    if (b.scope === "partner") return s.usePartner;
    return s.useSelf;
  }
  const amount = formatUsd(b.amountCents);
  if (b.action === "use-self-pay-partner") return fill(s.payBothWithTicket, { amount });
  if (b.scope === "both") return fill(s.payBoth, { amount });
  if (b.scope === "partner") return fill(s.payPartner, { amount });
  // "self" wording differs for a single-option (female) vs the male's secondary.
  return state.myGender === "male" ? fill(s.paySelf, { amount }) : fill(s.paySelfOnly, { amount });
}

function headerTitle(sc: TicketScreen, state: TicketState, s: TicketStrings): string {
  switch (sc) {
    case "offer":
      return s.heading;
    case "cover-partner":
      return s.coverPartnerTitle;
    case "waiting":
      return s.waitingTitle;
    case "success":
      return state.iCoveredPartner ? s.coveredHerTitle : s.successTitle;
    case "partner-paid":
      return fill(s.partnerPaidTitle, { name: state.partnerName ?? s.matchFallback });
    case "closed":
      return s.closedTitle;
  }
}

function headerSub(sc: TicketScreen, state: TicketState, s: TicketStrings): string {
  switch (sc) {
    case "offer":
      return s.sub;
    case "cover-partner":
      return fill(s.coverPartnerSub, { name: state.partnerName ?? s.matchFallback });
    case "waiting":
      return s.waitingSub;
    case "success":
      return state.iCoveredPartner
        ? fill(s.coveredHerSub, { name: state.partnerName ?? s.matchFallback })
        : s.successSub;
    case "partner-paid":
      return s.partnerPaidSub;
    case "closed":
      return s.closedSub;
  }
}

function errorText(err: unknown, s: TicketStrings): string {
  if (err instanceof CalendarApiError) return s.errGeneric;
  return s.errGeneric;
}
