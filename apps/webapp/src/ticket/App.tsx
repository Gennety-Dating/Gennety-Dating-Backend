import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { ButterflyLoader } from "../butterfly-loader-react.js";
import {
  fetchTicketState,
  createTicketIntent,
  createTicketStarsInvoice,
  confirmTicketPayment,
  useTicketFromWallet,
  ticketPhotoSrc,
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
  formatStars,
  starsForButton,
  type TicketScreen,
  type OfferButton,
} from "./ticket-state.js";
import { Ticket3D } from "./Ticket3D.js";
import { useActionBarSpace } from "./action-bar.js";
import { MockPayment } from "./MockPayment.js";
import { Confetti } from "./Confetti.js";
import { PartialTimer } from "./PartialTimer.js";
import { PartnerPaidCard } from "./PartnerPaidCard.js";
import { Avatar } from "./Avatar.js";
import { HeartMark } from "./marks.js";
import { returnParams } from "../return-to.js";
import { ReferralChip } from "../referral-hint-react.js";

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

// The profile photos stream through the bot's image proxy (getFile → Telegram),
// so the first fetch can take a couple of seconds. Preload the photos the
// about-to-render screen needs BEFORE leaving the spinner, so the avatars are
// already there instead of popping in after the screen appears.
const PRELOAD_TIMEOUT_MS = 6000;

function preloadImage(url: string): Promise<void> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve();
    img.onerror = () => resolve(); // never block the screen on a broken image
    img.src = url;
  });
}

function screenPhotoSrcs(state: TicketState): string[] {
  const mine = ticketPhotoSrc(state.myPhotoUrl, initData);
  const partner = ticketPhotoSrc(state.partnerPhotoUrl, initData);
  const sc = deriveScreen(state);
  const urls: Array<string | null> = [];
  if (sc === "partner-paid") urls.push(partner); // his photo on her reveal card
  else if (sc === "success" && state.iCoveredPartner) urls.push(partner); // her photo
  else if (sc === "offer" && state.myGender === "male") {
    urls.push(mine, partner); // pay-for-both button avatars
  } else if (sc === "cover-partner") {
    // Her face only — the cover screen shows the person he'd be covering, not
    // the pair. (It used to preload BOTH photos here and render neither, so the
    // spinner waited on images the screen never displayed.)
    urls.push(partner);
  }
  return urls.filter((u): u is string => Boolean(u));
}

async function preloadScreenPhotos(state: TicketState): Promise<void> {
  const urls = screenPhotoSrcs(state);
  if (urls.length === 0) return;
  // Bounded wait: photos usually finish well within the timeout; a slow network
  // still reveals the screen rather than hanging on the spinner forever.
  await Promise.race([
    Promise.all(urls.map(preloadImage)),
    new Promise<void>((resolve) => setTimeout(resolve, PRELOAD_TIMEOUT_MS)),
  ]);
}

export function App(): ReactElement {
  const s = strings(lang);
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  // "I'll let them grab it" — session-only (see ScreenOptions in ticket-state).
  // It survives the 4s poll because React state isn't remounted by it, and it
  // is reversible from the waiting screen.
  const [coverDeferred, setCoverDeferred] = useState(false);
  const myName = app?.initDataUnsafe?.user?.first_name ?? s.youFallback;
  // The action bar floats over the scroll; this measures it so the scroll
  // reserves exactly its height at the end (see action-bar.ts).
  const barRef = useActionBarSpace();

  // Ref to the latest phase so imperative MainButton handlers read fresh values.
  const phaseRef = useRef<Phase>(phase);
  phaseRef.current = phase;

  const load = useCallback(async (): Promise<void> => {
    try {
      const state = await fetchTicketState(initData, matchId);
      // Wait for the screen's photos before leaving the spinner (cached on
      // subsequent polls, so this is instant after the first load).
      await preloadScreenPhotos(state);
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
  const screen: TicketScreen | null =
    phase.kind === "view" ? deriveScreen(phase.state, { coverDeferred }) : null;
  useEffect(() => {
    // Poll while waiting on the partner (also on the male's "cover-partner"
    // screen, where the partner may pay herself in the meantime).
    //
    // "offer" polls too, because it is the screen a user can sit on for a long
    // time and the one where a stale render is actually expensive: the partner
    // may cover her ticket (she must flip to the surprise reveal, not keep
    // staring at a pay button she'd pay twice on), and the gate may expire and
    // open the Calendar for free (the buttons must become the "closed" screen).
    if (screen !== "waiting" && screen !== "cover-partner" && screen !== "offer") return;
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

  // Native Telegram Stars payment for the gate. Opens the invoice; the bot
  // settles the gate on successful_payment, so we just re-fetch state on "paid".
  const startStarsPayment = useCallback(
    async (scope: TicketScope): Promise<void> => {
      haptic("light");
      const open = app?.openInvoice;
      if (!open || !app) {
        app?.showAlert(s.errGeneric);
        return;
      }
      try {
        const { link } = await createTicketStarsInvoice(initData, matchId, scope);
        open.call(app, link, (status) => {
          if (status === "paid") {
            haptic("success");
            void load();
          } else if (status === "failed") {
            haptic("error");
            app?.showAlert(s.errGeneric);
          }
          // "cancelled" / "pending" → leave the screen as-is.
        });
      } catch (err) {
        app?.showAlert(errorText(err, s));
        // Refused invoice = stale screen (partner already paid, gate closed).
        // Re-read rather than leave a button that will keep failing.
        void load();
      }
    },
    [s, load],
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
        // A refused spend usually means the screen is stale (the gate expired,
        // or the partner settled first). Re-read so the user lands on the
        // correct screen instead of re-tapping a button that can't work.
        void load();
      }
    },
    [s, load],
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
        // Self covered with a wallet ticket; now pay one ticket's price for the
        // partner — natively in Stars when enabled, else the mock USD screen.
        if (next.starsEnabled) {
          setPhase({ kind: "view", state: next });
          void startStarsPayment("partner");
        } else {
          const intent = await createTicketIntent(initData, matchId, "partner");
          setPhase({ kind: "mock", state: next, scope: "partner", intent, processing: false });
        }
      } else {
        haptic("success");
        setPhase({ kind: "view", state: next });
      }
    } catch (err) {
      haptic("error");
      app?.showAlert(errorText(err, s));
      void load();
    }
  }, [s, load, startStarsPayment]);

  const onOfferButton = useCallback(
    (state: TicketState, b: OfferButton): void => {
      if (b.action === "use") void spendTicket(b.scope);
      else if (b.action === "use-self-pay-partner") void useSelfThenPayPartner();
      else if (state.starsEnabled) void startStarsPayment(b.scope);
      else void startPayment(state, b.scope);
    },
    [spendTicket, startPayment, startStarsPayment, useSelfThenPayPartner],
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
    return (
      <div className="ticket-page ticket-center">
        <ButterflyLoader label={s.loading} />
      </div>
    );
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
        <footer className="action-bar" ref={barRef}>
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
  const sc = deriveScreen(state, { coverDeferred });
  const myPhotoSrc = ticketPhotoSrc(state.myPhotoUrl, initData);
  const partnerPhotoSrc = ticketPhotoSrc(state.partnerPhotoUrl, initData);
  // He deferred the cover offer but nothing is settled on her side yet — keep a
  // quiet way back so "let them grab it" is a choice, not a one-way door.
  const canReconsiderCover =
    sc === "waiting" && coverDeferred && state.myGender === "male" && !state.partnerPaid;

  return (
    <div className="ticket-page has-bar">
      {sc === "success" && <Confetti />}
      <div className="ticket-scroll">
        {sc === "partner-paid" ? (
          <PartnerPaidCard
            partnerName={state.partnerName ?? s.matchFallback}
            partnerPhotoUrl={partnerPhotoSrc}
            strings={s}
          />
        ) : (
          <>
            <header className="ticket-header">
              <h1>{headerTitle(sc, state, s)}</h1>
              <p>{headerSub(sc, state, s)}</p>
              {/* The partner's remaining window belongs to the sentence above
                  it, not to the bottom of the scroll where it used to live —
                  see PartialTimer for why that position was both unreadable
                  and unexplained. */}
              {(sc === "waiting" || sc === "cover-partner") && (
                <PartialTimer expiresAt={state.expiresAt} strings={s} />
              )}
            </header>

            {sc === "success" && state.iCoveredPartner && (
              <div className="tkt-covered-hero">
                <Avatar
                  src={partnerPhotoSrc}
                  name={state.partnerName}
                  size={132}
                  badge={<HeartMark />}
                  className="tkt-avatar-hero"
                />
              </div>
            )}

            {/* The serial is seeded from the match, so this pair's ticket is
                genuinely their own rather than one shared by every pair whose
                names collide. The wallet count rides on the stub, and only on
                the two screens where it is still actionable — after the gate
                settles, how many tickets are left is no longer this screen's
                business. */}
            <Ticket3D
              myName={myName}
              partnerName={state.partnerName}
              balance={sc === "offer" || sc === "cover-partner" ? state.myBalance : null}
              strings={s}
            />

            {/* Referral cross-promo: a quiet secondary way to get a ticket
                without paying, shown only while the wallet is genuinely empty
                and only at the offer step — by "cover-partner" he already
                secured his own ticket, so the pitch no longer applies. It
                lives here (scroll content), never in the sticky action bar,
                so it can't compete with the pay/use buttons below. */}
            {sc === "offer" && state.myBalance === 0 && state.referralEnabled && (
              <ReferralChip
                lang={lang}
                onTap={() => {
                  haptic("light");
                  location.href = `referral.html?${returnParams("ticket-gate", { match: matchId, lang })}`;
                }}
              />
            )}

            {/* The cover offer is a distinct block UNDER his own "ticket
                secured" result, not the headline. Her face is the whole point
                of the gesture, so it leads the card. */}
            {sc === "cover-partner" && (
              <section className="tkt-cover-card">
                <Avatar src={partnerPhotoSrc} name={state.partnerName} size={64} />
                <div className="tkt-cover-copy">
                  <h2>{s.coverPartnerTitle}</h2>
                  <p>{fill(s.coverPartnerSub, { name: state.partnerName ?? s.matchFallback })}</p>
                </div>
              </section>
            )}
          </>
        )}
      </div>

      <footer className="action-bar" ref={barRef}>
        {sc === "offer" &&
          deriveOfferButtons(state).map((b) => {
            const discounted =
              !state.starsEnabled &&
              b.action === "pay" &&
              b.scope === "self" &&
              state.selfDiscountPct > 0;
            return (
              <button
                key={`${b.action}:${b.scope}`}
                type="button"
                className={`${b.primary ? "btn-hero" : "btn-secondary"}${discounted ? " btn-famine" : ""}${b.scope === "both" ? " btn-with-avatars" : ""}`}
                onClick={() => onOfferButton(state, b)}
              >
                {b.scope === "both" && (
                  <span className="btn-avatars" aria-hidden="true">
                    <Avatar src={myPhotoSrc} name={myName} size={44} />
                    <Avatar
                      src={partnerPhotoSrc}
                      name={state.partnerName}
                      size={44}
                      className="tkt-avatar-overlap"
                    />
                  </span>
                )}
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
                className={b.primary ? "btn-hero btn-with-avatars" : "btn-secondary"}
                onClick={() => onOfferButton(state, b)}
              >
                {b.primary && (
                  <span className="btn-avatars" aria-hidden="true">
                    <Avatar src={partnerPhotoSrc} name={state.partnerName} size={44} />
                  </span>
                )}
                {offerLabel(b, state, s)}
              </button>
            ))}
            {/* A real, bordered alternative — not a ghost text link — and it
                moves him to the waiting screen instead of closing the app. */}
            <button type="button" className="btn-ghost" onClick={() => setCoverDeferred(true)}>
              {s.justWait}
            </button>
          </>
        )}

        {(sc === "success" || sc === "partner-paid" || sc === "closed") && (
          <button type="button" className="btn-primary" onClick={goToScheduling}>
            {s.goToScheduling}
          </button>
        )}

        {/* Reopening the cover offer is the only ACTION on this screen, so it
            takes the button rung and Close drops to text under it. Close is
            not an action — Telegram renders its own ✕ in the chrome above —
            and it had the full-width glass button while the real choice was a
            14px grey link beneath, i.e. the exact inversion §3.5b corrected on
            the cover screen. With nothing to reconsider (a female, or a
            partner who already settled) Close is alone and keeps the rung. */}
        {sc === "waiting" && (
          <>
            {canReconsiderCover && (
              <button type="button" className="btn-secondary" onClick={() => setCoverDeferred(false)}>
                {s.coverReconsider}
              </button>
            )}
            <button
              type="button"
              className={canReconsiderCover ? "btn-text" : "btn-secondary"}
              onClick={() => app?.close()}
            >
              {s.close}
            </button>
          </>
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
  const amount =
    state.starsEnabled && state.stars
      ? formatStars(starsForButton(b, state.stars))
      : formatUsd(b.amountCents);
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
    // He just paid: the headline is HIS result, and the cover offer lives in
    // its own card below. `coverPartnerTitle`/`Sub` moved there.
    case "cover-partner":
      return s.waitingTitle;
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
      return s.waitingSub;
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
