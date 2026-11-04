import { useCallback, useEffect, useState } from "react";
import type { ReactElement } from "react";
import { ButterflyLoader } from "../butterfly-loader-react.js";
import {
  fetchTicketState,
  createTicketStarsInvoice,
  settleTicketNoCharge,
  useTicketFromWallet,
  ticketPhotoSrc,
  CalendarApiError,
  type TicketState,
  type TicketScope,
} from "../api.js";
import { pickLang, strings, fill, walletLine, type TicketStrings } from "./i18n.js";
import {
  deriveScreen,
  deriveOfferButtons,
  deriveCoverPartnerButtons,
  formatUsd,
  formatStars,
  settledForScope,
  starsForButton,
  type TicketScreen,
  type OfferButton,
} from "./ticket-state.js";
import { createInFlightGuard, pollUntil } from "../pay-flow.js";
import { createResponseEpoch } from "../request-epoch.js";
import { createIntervalPoller } from "../poller.js";
import { Ticket3D } from "./Ticket3D.js";
import { useActionBarSpace } from "./action-bar.js";
import { PartnerPaidCard } from "./PartnerPaidCard.js";
import { Avatar } from "./Avatar.js";
import {
  CountdownBadge,
  CoverDock,
  GlowPortrait,
  SecuredRow,
  TicketFillGlyph,
  TicketGlyph,
} from "./gate-parts.js";
import { returnParams } from "../return-to.js";
import { ReferralChip } from "../referral-hint-react.js";

const app = window.Telegram?.WebApp;
const params = new URLSearchParams(location.search);
const matchId = params.get("match") ?? "";
const lang = pickLang(params.get("lang") ?? app?.initDataUnsafe?.user?.language_code ?? null);
const initData = app?.initData ?? "";
document.documentElement?.setAttribute("lang", lang);

/**
 * One tap, one purchase (A13-M28). Module-level rather than React state: the
 * check and the set must happen in the same synchronous step as the tap, and a
 * state flag only changes on the next render — see `pay-flow.ts`.
 */
const payGuard = createInFlightGuard();
/**
 * The 4 s poll and a purchase used to race: a read that left before `/use`
 * landed after it and painted the unpaid screen back, and two overlapping reads
 * could land out of order (A13-L23). Every write invalidates the reads issued
 * before it, and a read older than one already painted is dropped — see
 * `request-epoch.ts`.
 */
const loadEpoch = createResponseEpoch();

type Phase =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "view"; state: TicketState };

function haptic(type: "light" | "success" | "error"): void {
  const h = app?.HapticFeedback;
  if (!h) return;
  if (type === "light") h.impactOccurred("light");
  else h.notificationOccurred(type);
}

/** The cover panel's touch feedback — every action answers under the finger. */
function dockHaptic(kind: "press" | "select" | "refused"): void {
  const h = app?.HapticFeedback;
  if (!h) return;
  if (kind === "press") h.impactOccurred("light");
  else if (kind === "select") h.selectionChanged();
  else h.notificationOccurred("error");
}

function openTicketStore(): void {
  location.href = `tickets.html?${returnParams("ticket-gate", { match: matchId, lang })}`;
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
  const partner = ticketPhotoSrc(state, "partner");
  const sc = deriveScreen(state);
  // Only the partner's face is ever drawn on the gate now: the offer's
  // portrait, the cover panel, the result's second row, her reveal card.
  // Preloading a photo the screen never shows only keeps the spinner up.
  const urls: Array<string | null> =
    sc === "partner-paid" || sc === "offer" || sc === "cover-partner" || sc === "success" ? [partner] : [];
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
  // Which offer the one action pays for (iOS variant B, 2026-10-30): "both" by
  // default, and the quiet line under the action switches to "only mine". The
  // two equal buttons it replaces read as two equal answers.
  const [scope, setScope] = useState<"both" | "self">("both");
  // Bumped on every refused spend so the cover panel folds its question back.
  const [spendFailed, setSpendFailed] = useState(0);
  const myName = app?.initDataUnsafe?.user?.first_name ?? s.youFallback;
  // The action bar floats over the scroll; this measures it so the scroll
  // reserves exactly its height at the end (see action-bar.ts).
  const barRef = useActionBarSpace();

  // The in-flight flag the buttons render from; `payGuard` is what actually
  // refuses the second tap, before this state has had a chance to re-render.
  const [paying, setPaying] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    const ticket = loadEpoch.begin();
    try {
      const state = await fetchTicketState(initData, matchId);
      // Wait for the screen's photos before leaving the spinner (cached on
      // subsequent polls, so this is instant after the first load).
      await preloadScreenPhotos(state);
      // A purchase started, or a newer read already painted, while this one
      // was out — its answer is older than what is on screen.
      if (!loadEpoch.claim(ticket)) return;
      setPhase({ kind: "view", state });
    } catch (err) {
      if (!loadEpoch.claim(ticket)) return;
      setPhase({ kind: "error", message: errorText(err, s) });
    }
  }, [s]);

  /** Paint a state a write just returned, retiring every read that predates it. */
  const applyWrite = useCallback((next: TicketState): void => {
    loadEpoch.invalidate();
    setPhase({ kind: "view", state: next });
  }, []);

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
    //
    // "offer" polls too, because it is the screen a user can sit on for a long
    // time and the one where a stale render is actually expensive: the partner
    // may cover her ticket (she must flip to the surprise reveal, not keep
    // staring at a pay button she'd pay twice on), and the gate may expire and
    // open the Calendar for free (the buttons must become the "closed" screen).
    if (screen !== "waiting" && screen !== "cover-partner" && screen !== "offer") return;
    // Same 4 s cadence, one read at a time: a tick that finds the last read
    // (its photo preload included) still out is skipped — see `poller.ts`.
    const poll = createIntervalPoller(4000, load);
    poll.start();
    return () => poll.stop();
  }, [screen, load]);

  // ── Payment actions ──────────────────────────────────────────────────────
  // Demo and local development only (`rail === "no-charge"`): the gate settles
  // on the tap, with no payment screen in between. Production never gets here —
  // Stars is on there, so every pay button opens the native invoice below, and
  // the route answers 404 wherever money can move. The card form that used to
  // sit on this path imitated a Stripe integration that never shipped
  // (decision 2026-09-11).
  const settleWithoutCharge = useCallback(
    async (scope: TicketScope): Promise<void> => {
      haptic("light");
      loadEpoch.invalidate();
      try {
        const next = await settleTicketNoCharge(initData, matchId, scope);
        haptic("success");
        applyWrite(next);
      } catch (err) {
        haptic("error");
        app?.showAlert(errorText(err, s));
        // A refusal usually means a stale screen (the partner settled first,
        // the gate closed) — re-read rather than leave a dead button.
        void load();
      }
    },
    [s, load, applyWrite],
  );

  // Native Telegram Stars payment for the gate. Opens the invoice; the bot
  // settles the gate on successful_payment. Resolves only once the whole flow
  // is over — sheet closed, and on "paid" the settle seen — because the caller
  // holds the pay guard until then.
  const startStarsPayment = useCallback(
    async (scope: TicketScope): Promise<void> => {
      haptic("light");
      const open = app?.openInvoice;
      if (!open || !app) {
        app?.showAlert(s.errGeneric);
        return;
      }
      let link: string;
      try {
        ({ link } = await createTicketStarsInvoice(initData, matchId, scope));
      } catch (err) {
        app.showAlert(errorText(err, s));
        // Refused invoice = stale screen (partner already paid, gate closed).
        // Re-read rather than leave a button that will keep failing.
        void load();
        return;
      }
      const status = await new Promise<"paid" | "cancelled" | "failed" | "pending">((resolve) =>
        open.call(app, link, resolve),
      );
      if (status === "failed") {
        haptic("error");
        app.showAlert(s.errGeneric);
        return;
      }
      // "cancelled" / "pending" → leave the screen as-is.
      if (status !== "paid") return;

      haptic("success");
      // Hold a spinner until the server agrees, like Premium does: a single
      // re-read here usually beat the bot's successful_payment and drew the
      // pay button again under a user who had just paid (A13-M28).
      loadEpoch.invalidate();
      setPhase({ kind: "loading" });
      const { value } = await pollUntil(
        () => fetchTicketState(initData, matchId),
        (state) => settledForScope(state, scope),
      );
      if (!value) {
        void load();
        return;
      }
      await preloadScreenPhotos(value);
      applyWrite(value);
    },
    [s, load, applyWrite],
  );

  // Spend a wallet ticket (no payment screen) — settles the gate immediately.
  const spendTicket = useCallback(
    async (scope: TicketScope): Promise<void> => {
      haptic("light");
      loadEpoch.invalidate();
      try {
        const next = await useTicketFromWallet(initData, matchId, scope);
        haptic("success");
        applyWrite(next);
      } catch (err) {
        haptic("error");
        setSpendFailed((n) => n + 1);
        app?.showAlert(errorText(err, s));
        // A refused spend usually means the screen is stale (the gate expired,
        // or the partner settled first). Re-read so the user lands on the
        // correct screen instead of re-tapping a button that can't work.
        void load();
      }
    },
    [s, load, applyWrite],
  );

  // Male "cover both" holding exactly one wallet ticket: spend it on his own
  // slot, then open the single-price ($8.49) payment for the partner's slot —
  // 🎫 + one ticket's money, never the doubled "pay for both". If the partner
  // settled concurrently we just show the refreshed (cover-partner/success)
  // screen instead of a redundant charge.
  const useSelfThenPayPartner = useCallback(async (): Promise<void> => {
    haptic("light");
    loadEpoch.invalidate();
    try {
      const next = await useTicketFromWallet(initData, matchId, "self");
      if (!next.bothPaid && next.iPaid && !next.partnerPaid) {
        // Self covered with a wallet ticket; now pay one ticket's price for the
        // partner — natively in Stars, or (demo / development) without a charge.
        if (next.starsEnabled) {
          applyWrite(next);
          // Awaited, not fired off: the pay guard is held until the invoice
          // flow is over, so the partner's button cannot open a second sheet.
          await startStarsPayment("partner");
        } else {
          const settled = await settleTicketNoCharge(initData, matchId, "partner");
          haptic("success");
          applyWrite(settled);
        }
      } else {
        haptic("success");
        applyWrite(next);
      }
    } catch (err) {
      haptic("error");
      app?.showAlert(errorText(err, s));
      void load();
    }
  }, [s, load, applyWrite, startStarsPayment]);

  const onOfferButton = useCallback(
    (state: TicketState, b: OfferButton): void => {
      // Claimed before anything awaits: a second tap in the gap before the
      // invoice sheet opens used to mint a second invoice (A13-M28).
      if (!payGuard.tryEnter()) return;
      setPaying(true);
      const flight =
        b.action === "use"
          ? spendTicket(b.scope)
          : b.action === "use-self-pay-partner"
            ? useSelfThenPayPartner()
            : state.starsEnabled
              ? startStarsPayment(b.scope)
              : settleWithoutCharge(b.scope);
      void flight.finally(() => {
        payGuard.leave();
        setPaying(false);
      });
    },
    [spendTicket, settleWithoutCharge, startStarsPayment, useSelfThenPayPartner],
  );

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
  const state = phase.state;
  const sc = deriveScreen(state);
  const partnerPhotoSrc = ticketPhotoSrc(state, "partner");
  const partnerName = state.partnerName ?? s.matchFallback;

  // Offer: one action for the chosen scope; the alternative lives in the quiet
  // line under it, and only when there is one (a male who can still cover).
  const offerButtons = sc === "offer" ? deriveOfferButtons(state) : [];
  const heroButton = offerButtons.find((b) => b.primary) ?? offerButtons[0] ?? null;
  const altButton = offerButtons.find((b) => !b.primary) ?? null;
  const offerButton = scope === "self" && altButton ? altButton : heroButton;
  const coverButton = sc === "cover-partner" ? (deriveCoverPartnerButtons(state)[0] ?? null) : null;
  // The window only means something while a ticket is still owed.
  const showsDeadline =
    Boolean(state.expiresAt) && (sc === "offer" || sc === "cover-partner" || sc === "waiting");
  const premiumPlate =
    state.myPremiumActive && state.iPaid && (sc === "waiting" || sc === "cover-partner");

  return (
    <div className={`ticket-page has-bar gate-b gate-${sc}`}>
      {showsDeadline && state.expiresAt ? (
        <div className="gate-topbar">
          <CountdownBadge expiresAt={state.expiresAt} label={s.deadlineLabel} />
        </div>
      ) : null}

      <div className="ticket-scroll">
        {sc === "partner-paid" ? (
          <PartnerPaidCard
            partnerName={partnerName}
            partnerPhotoUrl={partnerPhotoSrc}
            strings={s}
          />
        ) : sc === "offer" ? (
          <>
            <GlowPortrait src={partnerPhotoSrc} name={state.partnerName} size={84} />
            <header className="ticket-header gate-header">
              <h1>{s.heading}</h1>
              <p>{s.sub}</p>
            </header>
            {/* The free path to a ticket sits in the content, never among the
                pay actions (the chip rule iOS `ReferralChip` follows too). */}
            {state.myBalance === 0 && state.referralEnabled && (
              <ReferralChip
                lang={lang}
                onTap={() => {
                  haptic("light");
                  location.href = `referral.html?${returnParams("ticket-gate", { match: matchId, lang })}`;
                }}
              />
            )}
            {/* No wallet count on the stub: whether the tickets suffice is said
                by the action itself — «Использовать» or a price (iOS 2026-10-01). */}
            <div className="gate-ticket">
              <Ticket3D myName={myName} partnerName={state.partnerName} balance={null} strings={s} />
            </div>
          </>
        ) : sc === "cover-partner" || sc === "waiting" ? (
          <div className="gate-center">
            <TicketGlyph size={64} />
            <header className="ticket-header gate-header gate-header-tight">
              <h1>{s.waitingTitle}</h1>
              <p>{s.waitingSub}</p>
            </header>
            {premiumPlate && <p className="gate-premium-plate">{s.premiumCovered}</p>}
          </div>
        ) : sc === "success" ? (
          // The result does not fly past: it stands until «Выбрать время» and
          // says whose ticket is in (founder's pick 2026-10-30).
          <div className="gate-center gate-secured">
            <h1 className="gate-secured-heading">{s.successTitle}</h1>
            <div className="gate-secured-rows">
              <SecuredRow lead={<TicketFillGlyph />} title={s.securedMine} />
              <SecuredRow
                lead={<Avatar src={partnerPhotoSrc} name={state.partnerName} size={36} className="gate-portrait" />}
                title={partnerName}
              />
            </div>
          </div>
        ) : (
          <>
            <header className="ticket-header">
              <h1>{s.closedTitle}</h1>
              <p>{s.closedSub}</p>
            </header>
            <Ticket3D myName={myName} partnerName={state.partnerName} balance={null} strings={s} />
          </>
        )}
      </div>

      {sc === "cover-partner" && coverButton ? (
        <CoverDock
          partnerSrc={partnerPhotoSrc}
          partnerName={state.partnerName}
          title={s.coverPartnerTitle}
          body={fill(s.coverPartnerSub, { name: partnerName })}
          premiumNote={
            state.myPremiumActive ? fill(s.premiumCoverNotIncluded, { name: partnerName }) : null
          }
          actionLabel={s.coverAction}
          confirmLabel={s.coverConfirm}
          cancelLabel={s.coverCancel}
          confirmHint={s.coverConfirmHint}
          asks={coverButton.action === "use"}
          working={paying}
          failed={spendFailed}
          onSpend={() => onOfferButton(state, coverButton)}
          haptic={dockHaptic}
          footer={
            <button type="button" className="gate-wallet-line" onClick={() => {
              dockHaptic("press");
              openTicketStore();
            }}>
              <span>{walletLine(lang, state.myBalance)}</span>
              <span className="gate-wallet-topup">{s.walletTopUp}</span>
            </button>
          }
        />
      ) : null}

      {sc !== "cover-partner" && sc !== "waiting" && (
        <footer className="action-bar gate-bar" ref={barRef}>
          {sc === "offer" && offerButton && (
            <>
              <button
                key={`${offerButton.action}:${offerButton.scope}`}
                type="button"
                className={`gate-pill gate-offer-pill${isFamine(offerButton, state) ? " btn-famine" : ""}`}
                disabled={paying}
                onClick={() => onOfferButton(state, offerButton)}
              >
                {isFamine(offerButton, state) && (
                  <span className="ticket-famine-badge">
                    {fill(s.famineBadge, { pct: String(state.selfDiscountPct) })}
                  </span>
                )}
                {offerLabel(offerButton, state, s)}
              </button>
              {altButton ? (
                <button
                  type="button"
                  className="gate-scope-line"
                  disabled={paying}
                  onClick={() => {
                    app?.HapticFeedback?.selectionChanged();
                    setScope((v) => (v === "both" ? "self" : "both"));
                  }}
                >
                  {scope === "both" ? s.scopeOnlyMine : s.scopeBoth}
                </button>
              ) : (
                // Holds the line's height so the action stays where it was.
                <span className="gate-scope-line gate-scope-spacer" aria-hidden="true" />
              )}
            </>
          )}

          {(sc === "success" || sc === "partner-paid" || sc === "closed") && (
            <button type="button" className="gate-pill gate-pill-wide" onClick={goToScheduling}>
              {s.goToScheduling}
            </button>
          )}
        </footer>
      )}
    </div>
  );
}

/** The famine discount rides only on the actor's own money ticket. */
function isFamine(b: OfferButton, state: TicketState): boolean {
  return !state.starsEnabled && b.action === "pay" && b.scope === "self" && state.selfDiscountPct > 0;
}

function offerLabel(b: OfferButton, state: TicketState, s: TicketStrings): string {
  if (b.action === "use") {
    if (b.scope === "both") return s.useBoth;
    if (b.scope === "partner") return s.coverAction;
    return s.useSelf;
  }
  const amount =
    state.starsEnabled && state.stars
      ? formatStars(starsForButton(b, state.stars))
      : formatUsd(b.amountCents);
  return fill(s.payAmount, { amount });
}

function errorText(err: unknown, s: TicketStrings): string {
  if (err instanceof CalendarApiError) return s.errGeneric;
  return s.errGeneric;
}
