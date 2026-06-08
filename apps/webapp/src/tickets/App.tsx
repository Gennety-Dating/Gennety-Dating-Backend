import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import {
  fetchWalletState,
  createStoreIntent,
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
import { storeBundles, formatUsd, type StoreBundleView } from "./store-state.js";
import {
  pickLang as pickTicketLang,
  strings as ticketStrings,
} from "../ticket/i18n.js";
import { Ticket3D } from "../ticket/Ticket3D.js";
import { MockPayment } from "../ticket/MockPayment.js";
import { Confetti } from "../ticket/Confetti.js";

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
  | { kind: "view"; balance: number; justBought: number | null }
  | { kind: "mock"; balance: number; bundle: StoreBundleView; intent: StoreIntent; processing: boolean };

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

  const load = useCallback(async (): Promise<void> => {
    try {
      const wallet = await fetchWalletState(initData);
      setPhase({ kind: "view", balance: wallet.balance, justBought: null });
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
    async (balance: number, bundle: StoreBundleView): Promise<void> => {
      haptic("light");
      try {
        const intent = await createStoreIntent(initData, bundle.count);
        setPhase({ kind: "mock", balance, bundle, intent, processing: false });
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
      setPhase({ kind: "view", balance: wallet.balance, justBought: current.bundle.count });
    } catch (err) {
      haptic("error");
      app?.showAlert(errorText(err, s));
      setPhase((p) => (p.kind === "mock" ? { ...p, processing: false } : p));
    }
  }, [s]);

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
            onClick={() => setPhase({ kind: "view", balance: phase.balance, justBought: null })}
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

        <Ticket3D myName={s.anonHolderA} partnerName={s.anonHolderB} strings={ticketS} />

        <p className="ticket-balance-note">{fill(s.balance, { n: String(phase.balance) })}</p>

        <div className="store-bundles">
          {storeBundles().map((b) => (
            <button
              key={b.count}
              type="button"
              className={`store-bundle${b.bestValue ? " store-bundle-best" : ""}`}
              onClick={() => void startPurchase(phase.balance, b)}
            >
              <span className="store-bundle-main">
                {fill(s.buy, { count: String(b.count), amount: formatUsd(b.priceCents) })}
              </span>
              <span className="store-bundle-per">
                {fill(s.perTicket, { amount: formatUsd(b.perTicketCents) })}
                {b.bestValue ? ` · ${s.bestValue}` : ""}
              </span>
            </button>
          ))}
        </div>
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
