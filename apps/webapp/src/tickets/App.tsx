import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { ButterflyLoader } from "../butterfly-loader-react.js";
import {
  fetchWalletState,
  createStoreIntent,
  createStoreStarsInvoice,
  confirmStorePurchase,
  CalendarApiError,
  type StoreIntent,
} from "../api.js";
import {
  pickLang as pickStoreLang,
  strings as storeStrings,
  fill,
  type StoreStrings,
} from "./i18n.js";
import {
  storeBundles,
  storeBundlesStars,
  formatUsd,
  formatStars,
  type StoreBundleView,
  type StoreStarsBundleView,
} from "./store-state.js";
import {
  pickLang as pickTicketLang,
  strings as ticketStrings,
} from "../ticket/i18n.js";
import { Ticket3D } from "../ticket/Ticket3D.js";
import { MockPayment } from "../ticket/MockPayment.js";
import { Confetti } from "../ticket/Confetti.js";
import { returnParams } from "../return-to.js";
import { ReferralChip } from "../referral-hint-react.js";

const app = window.Telegram?.WebApp;
const params = new URLSearchParams(location.search);
const rawLang = params.get("lang") ?? app?.initDataUnsafe?.user?.language_code ?? null;
const lang = pickStoreLang(rawLang);
const ticketS = ticketStrings(pickTicketLang(rawLang));
const initData = app?.initData ?? "";
document.documentElement?.setAttribute("lang", lang);

type Phase =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | {
      kind: "view";
      balance: number;
      justBought: number | null;
      discountPct: number;
      starsEnabled: boolean;
      bundleStars: Record<string, number> | null;
    }
  | {
      kind: "mock";
      balance: number;
      bundle: StoreBundleView;
      intent: StoreIntent;
      processing: boolean;
      discountPct: number;
    };

function haptic(type: "light" | "success" | "error"): void {
  const h = app?.HapticFeedback;
  if (!h) return;
  if (type === "light") h.impactOccurred("light");
  else h.notificationOccurred(type);
}

export function App(): ReactElement {
  const s = storeStrings(lang);
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const phaseRef = useRef<Phase>(phase);
  phaseRef.current = phase;
  // Kept separate from `Phase` (rather than threaded through every `setPhase`
  // call site) since it never changes what screen is shown, only whether a
  // quiet secondary link appears on it.
  const [referralEnabled, setReferralEnabled] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      const wallet = await fetchWalletState(initData);
      setReferralEnabled(Boolean(wallet.referralEnabled));
      setPhase({
        kind: "view",
        balance: wallet.balance,
        justBought: null,
        discountPct: wallet.discountPct,
        starsEnabled: Boolean(wallet.starsEnabled),
        bundleStars: wallet.bundleStars ?? null,
      });
    } catch (err) {
      setPhase({ kind: "error", message: errorText(err, s) });
    }
  }, [s]);

  useEffect(() => {
    if (!initData) {
      setPhase({ kind: "error", message: s.errGeneric });
      return;
    }
    void load();
  }, [load, s.errGeneric]);

  const startPurchase = useCallback(
    async (balance: number, discountPct: number, bundle: StoreBundleView): Promise<void> => {
      haptic("light");
      try {
        const intent = await createStoreIntent(initData, bundle.count);
        setPhase({ kind: "mock", balance, bundle, intent, processing: false, discountPct });
      } catch (err) {
        app?.showAlert(errorText(err, s));
      }
    },
    [s],
  );

  // Native Telegram Stars purchase from inside the store. Opens the invoice; the
  // bot credits the wallet on successful_payment (exactly `count`), so the
  // optimistic balance is also the accurate one.
  const startStarsPurchase = useCallback(
    async (
      balance: number,
      bundleStars: Record<string, number> | null,
      bundle: StoreStarsBundleView,
    ): Promise<void> => {
      haptic("light");
      const open = app?.openInvoice;
      if (!open || !app) {
        app?.showAlert(s.errGeneric);
        return;
      }
      try {
        const { link } = await createStoreStarsInvoice(initData, bundle.count);
        open.call(app, link, (status) => {
          if (status === "paid") {
            haptic("success");
            setPhase({
              kind: "view",
              balance: balance + bundle.count,
              justBought: bundle.count,
              discountPct: 0,
              starsEnabled: true,
              bundleStars,
            });
          } else if (status === "failed") {
            haptic("error");
            app?.showAlert(s.errGeneric);
          }
          // "cancelled" / "pending" → leave the store screen as-is.
        });
      } catch (err) {
        app?.showAlert(errorText(err, s));
      }
    },
    [s],
  );

  const completePurchase = useCallback(async (): Promise<void> => {
    setPhase((p) => (p.kind === "mock" ? { ...p, processing: true } : p));
    const current = phaseRef.current;
    if (current.kind !== "mock") return;
    try {
      const wallet = await confirmStorePurchase(initData, current.bundle.count, current.intent.clientSecret);
      haptic("success");
      setReferralEnabled(Boolean(wallet.referralEnabled));
      setPhase({
        kind: "view",
        balance: wallet.balance,
        justBought: current.bundle.count,
        discountPct: wallet.discountPct,
        starsEnabled: Boolean(wallet.starsEnabled),
        bundleStars: wallet.bundleStars ?? null,
      });
    } catch (err) {
      haptic("error");
      app?.showAlert(errorText(err, s));
      setPhase((p) => (p.kind === "mock" ? { ...p, processing: false } : p));
    }
  }, [s]);

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
          <MockPayment amountCents={phase.intent.amountCents} strings={ticketS} />
        </div>
        <footer className="action-bar">
          <button
            type="button"
            className="btn-primary"
            disabled={phase.processing}
            onClick={() => void completePurchase()}
          >
            {phase.processing ? s.processing : fill(ticketS.mockPayNow, { amount })}
          </button>
          <button
            type="button"
            className="btn-text"
            disabled={phase.processing}
            onClick={() =>
              setPhase({
                kind: "view",
                balance: phase.balance,
                justBought: null,
                discountPct: phase.discountPct,
                starsEnabled: false,
                bundleStars: null,
              })
            }
          >
            {s.back}
          </button>
        </footer>
      </div>
    );
  }

  const bought = phase.justBought !== null;
  return (
    <div className="ticket-page has-bar">
      {bought && <Confetti />}
      <div className="ticket-scroll">
        <header className="ticket-header">
          <h1>{bought ? s.successTitle : s.title}</h1>
          <p>
            {bought
              ? fill(s.successSub, { n: String(phase.balance) })
              : s.sub}
          </p>
        </header>

        {/* The store's card carries no names — it is the product, not anyone's
            ticket. It used to print "Участник & Твоя пара", which is the only
            place in the app where a fabricated pair was shown as if issued.
            The wallet count rides on its stub instead of in a pill below. */}
        <Ticket3D seed="gennety-store" balance={phase.balance} strings={ticketS} />

        <div className="store-bundles">
          {phase.starsEnabled && phase.bundleStars
            ? storeBundlesStars(phase.bundleStars).map((b) => (
                <button
                  key={b.count}
                  type="button"
                  className={`store-bundle${b.bestValue ? " store-bundle-best" : ""}`}
                  onClick={() => void startStarsPurchase(phase.balance, phase.bundleStars, b)}
                >
                  {b.discountPct > 0 && (
                    <span className={`store-badge${b.bestValue ? " store-badge-best" : ""}`}>
                      {fill(s.save, { pct: String(b.discountPct) })}
                    </span>
                  )}
                  <span className="store-bundle-emblem" aria-hidden="true">
                    <span className="store-bundle-emblem-x">×</span>
                    <span className="store-bundle-emblem-n">{b.count}</span>
                  </span>
                  <span className="store-bundle-info">
                    <span className="store-bundle-main">
                      {fill(s.buy, { count: String(b.count), amount: formatStars(b.stars) })}
                    </span>
                    <span className="store-bundle-per">
                      {fill(s.perTicket, { amount: formatStars(b.perTicketStars) })}
                      {b.bestValue && <span className="store-bundle-tag">{s.bestValue}</span>}
                    </span>
                  </span>
                </button>
              ))
            : storeBundles(phase.discountPct).map((b) => (
            <button
              key={b.count}
              type="button"
              className={`store-bundle${b.bestValue ? " store-bundle-best" : ""}${b.famineDiscountPct > 0 ? " store-bundle-famine" : ""}`}
              onClick={() => void startPurchase(phase.balance, phase.discountPct, b)}
            >
              {b.famineDiscountPct > 0 ? (
                <span className="store-badge store-badge-famine">
                  {fill(s.famineSave, { pct: String(b.famineDiscountPct) })}
                </span>
              ) : (
                b.discountPct > 0 && (
                  <span className={`store-badge${b.bestValue ? " store-badge-best" : ""}`}>
                    {fill(s.save, { pct: String(b.discountPct) })}
                  </span>
                )
              )}
              <span className="store-bundle-emblem" aria-hidden="true">
                <span className="store-bundle-emblem-x">×</span>
                <span className="store-bundle-emblem-n">{b.count}</span>
              </span>
              <span className="store-bundle-info">
                <span className="store-bundle-main">
                  {fill(s.buy, { count: String(b.count), amount: formatUsd(b.priceCents) })}
                </span>
                <span className="store-bundle-per">
                  {fill(s.perTicket, { amount: formatUsd(b.perTicketCents) })}
                  {b.bestValue && <span className="store-bundle-tag">{s.bestValue}</span>}
                </span>
              </span>
            </button>
          ))}
        </div>

        {/* Referral cross-promo: a quiet secondary way to get tickets without
            paying, shown only while the wallet is genuinely empty — never
            competing with the bundle buttons above it. */}
        {!bought && phase.balance === 0 && referralEnabled && (
          <ReferralChip
            lang={lang}
            onTap={() => {
              haptic("light");
              location.href = `referral.html?${returnParams("ticket-store", { lang })}`;
            }}
          />
        )}
      </div>

      {bought && (
        <footer className="action-bar">
          <button type="button" className="btn-primary" onClick={() => app?.close()}>
            {s.done}
          </button>
        </footer>
      )}
    </div>
  );
}

function errorText(err: unknown, s: StoreStrings): string {
  if (err instanceof CalendarApiError) return s.errGeneric;
  return s.errGeneric;
}
