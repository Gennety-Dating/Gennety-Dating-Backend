import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent, ReactElement, ReactNode } from "react";
import type { TelegramProfileBasics, TelegramProfileLimits, TelegramProfilePatch } from "./api.js";
import type { BasicsStep } from "./onboarding-basics-route.js";
import { basicsStepIndex } from "./onboarding-basics-route.js";
import { burstFromEvent } from "./onboarding-burst.js";
import type { BurstTone } from "./onboarding-burst.js";
import { errorCopy } from "./onboarding-errors.js";
import type { OnboardingStrings } from "./onboarding-i18n.js";
import { placeScatter } from "./preference-layout.js";
import type { ScatterSlot } from "./preference-layout.js";
import { photoSet, warmPreferencePhotos } from "./preference-photos.js";
import { PREF_REVEAL_CAP_MS, revealTally } from "./preference-reveal.js";
import { WHEEL_ITEM_H, shouldTickHaptic, wheelValueAt } from "./onboarding-wheel.js";

/**
 * The Mini App's own profile screens: name, age, gender, who you're looking
 * for, height (PRODUCT_SPEC §1.3).
 *
 * These five moved out of the chat because each has ONE correct answer from a
 * finite set, and Telegram has no way to render the right control for that —
 * the bot had to ask in prose and then recover the value with a regex or an
 * LLM. (The native iOS client already gets purpose-built controls here; see
 * `apps/bot/src/public/ui-hints.ts`.)
 *
 * House rules the screens follow, deliberately:
 *  - one question, one control, nothing else. No lead paragraph, no helper
 *    text, no card frame — the control is the explanation.
 *  - the action is a floating pill carrying the brand's inner-edge sheen, not
 *    Telegram's MainButton (the bar welded to the bottom of the viewport). Same
 *    call as the biometric-consent screen.
 *  - a screen advances only after its answer is saved. Optimistic advance would
 *    read faster and then strand a failed write two screens back.
 */

const app = window.Telegram?.WebApp;

/** Where the wheel and the slider open when the user has no value yet. */
const DEFAULT_AGE = 25;
const DEFAULT_HEIGHT_CM = 175;

export interface BasicsGateProps {
  step: BasicsStep;
  basics: TelegramProfileBasics;
  limits: TelegramProfileLimits;
  strings: OnboardingStrings;
  /** Persists one screen's answer; rejects with the server's reason. */
  onSave: (patch: TelegramProfilePatch) => Promise<void>;
}

export function BasicsGate(props: BasicsGateProps): ReactElement {
  const { step, basics, limits, strings } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Clear a stale error when the user moves to another screen.
  useEffect(() => {
    setError(null);
  }, [step]);

  // Start the "who do you want to meet?" photographs downloading and decoding
  // the moment the profile screens begin — three screens before the one that
  // shows them, so they land while the user is typing a name rather than while
  // they are looking at the screen (preference-photos.ts). Skipped for someone
  // resumed past that screen, who would otherwise pay half a megabyte for a
  // picture they are never shown; a back-navigation into it re-runs this.
  const warmPhotos = basicsStepIndex(step) <= basicsStepIndex("preference");
  useEffect(() => {
    if (warmPhotos) warmPreferencePhotos();
  }, [warmPhotos]);

  const save = useCallback(
    async (patch: TelegramProfilePatch): Promise<void> => {
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        await props.onSave(patch);
        app?.HapticFeedback?.selectionChanged();
      } catch (err) {
        setError(errorCopy(err, strings));
        app?.HapticFeedback?.notificationOccurred("error");
      } finally {
        setBusy(false);
      }
    },
    [busy, props.onSave, strings],
  );

  const errorNode = error ? <div className="ob-basics-error">{error}</div> : null;

  switch (step) {
    case "name":
      return (
        <NameScreen
          strings={strings}
          initial={basics.firstName ?? ""}
          busy={busy}
          error={errorNode}
          onSubmit={(firstName) => void save({ firstName })}
        />
      );
    case "age":
      return (
        <AgeScreen
          strings={strings}
          limits={limits}
          initial={basics.age ?? DEFAULT_AGE}
          busy={busy}
          error={errorNode}
          onSubmit={(age) => void save({ age })}
        />
      );
    case "gender":
      return (
        <ChoiceScreen
          title={strings.basicsGenderTitle}
          busy={busy}
          error={errorNode}
          selected={basics.gender}
          options={[
            { value: "male", label: strings.basicsGenderMale, tone: "male" },
            { value: "female", label: strings.basicsGenderFemale, tone: "female" },
          ]}
          onPick={(gender) => void save({ gender: gender as "male" | "female" })}
        />
      );
    case "preference":
      return (
        <PreferenceScreen
          strings={strings}
          busy={busy}
          error={errorNode}
          selected={basics.preference}
          onPick={(preference) =>
            void save({ preference: preference as "men" | "women" | "both" })
          }
        />
      );
    case "height":
      return (
        <HeightScreen
          strings={strings}
          limits={limits}
          initial={basics.height ?? DEFAULT_HEIGHT_CM}
          busy={busy}
          error={errorNode}
          onSubmit={(height) => void save({ height })}
        />
      );
  }
}

/** The shared frame: question up top, control in the middle, pill at the foot. */
function BasicsShell(props: {
  /** Omitted on the name screen, where the field's placeholder is the ask. */
  title?: string;
  error: ReactNode;
  children: ReactNode;
  /** Omitted on the tap-to-answer screens, where the option IS the action. */
  action?: ReactNode;
  modifier?: string;
}): ReactElement {
  return (
    <main className={`ob-basics ${props.modifier ?? ""}`}>
      {props.title ? <h1 className="ob-basics-title">{props.title}</h1> : null}
      <div className="ob-basics-body">{props.children}</div>
      {props.error}
      {props.action ? <div className="ob-basics-foot">{props.action}</div> : null}
    </main>
  );
}

function ContinuePill(props: {
  label: string;
  disabled: boolean;
  onClick: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      className="ob-basics-pill"
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.label}
    </button>
  );
}

function NameScreen(props: {
  strings: OnboardingStrings;
  initial: string;
  busy: boolean;
  error: ReactNode;
  onSubmit: (name: string) => void;
}): ReactElement {
  const [name, setName] = useState(props.initial);
  const inputRef = useRef<HTMLInputElement>(null);
  const trimmed = name.trim();

  // Raise the keyboard on arrival: this screen is nothing but a field, so
  // making the user tap it first is a wasted step. `--kb-height` (onboarding.tsx)
  // already shrinks the layout so the pill stays above the keyboard.
  useEffect(() => {
    const timer = window.setTimeout(() => inputRef.current?.focus(), 220);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <BasicsShell
      error={props.error}
      modifier="ob-basics--name"
      action={
        <ContinuePill
          label={props.busy ? props.strings.saving : props.strings.continue}
          disabled={props.busy || trimmed.length < 2}
          onClick={() => props.onSubmit(trimmed)}
        />
      }
    >
      <input
        ref={inputRef}
        className="ob-basics-input"
        type="text"
        autoCapitalize="words"
        autoComplete="given-name"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="done"
        maxLength={40}
        // The visible question is gone from this screen; the field is the whole
        // ask. Keep it as the accessible name so a screen reader still says it.
        aria-label={props.strings.basicsNameTitle}
        placeholder={props.strings.basicsNamePlaceholder}
        value={name}
        onChange={(event) => setName(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && trimmed.length >= 2 && !props.busy) {
            event.preventDefault();
            props.onSubmit(trimmed);
          }
        }}
      />
    </BasicsShell>
  );
}

function AgeScreen(props: {
  strings: OnboardingStrings;
  limits: TelegramProfileLimits;
  initial: number;
  busy: boolean;
  error: ReactNode;
  onSubmit: (age: number) => void;
}): ReactElement {
  const { minAge, maxAge } = props.limits;
  const [age, setAge] = useState(() => clamp(props.initial, minAge, maxAge));
  const filled = ((age - minAge) / Math.max(1, maxAge - minAge)) * 100;

  return (
    <BasicsShell
      title={props.strings.basicsAgeTitle}
      error={props.error}
      action={
        <ContinuePill
          label={props.busy ? props.strings.saving : props.strings.continue}
          disabled={props.busy}
          onClick={() => props.onSubmit(age)}
        />
      }
    >
      <div className="ob-basics-readout" aria-hidden="true">
        {age}
      </div>
      {/* A styled native range input rather than a hand-rolled pointer drag:
          same look, but touch inertia, keyboard control and the screen reader
          come for free. `--filled` drives the burgundy portion of the track. */}
      <input
        className="ob-slider"
        type="range"
        min={minAge}
        max={maxAge}
        step={1}
        value={age}
        aria-label={props.strings.basicsAgeTitle}
        style={{ ["--filled" as string]: `${filled}%` }}
        onChange={(event) => {
          const next = Number(event.currentTarget.value);
          if (next !== age) app?.HapticFeedback?.selectionChanged();
          setAge(next);
        }}
      />
      <div className="ob-slider-ends" aria-hidden="true">
        <span>{minAge}</span>
        <span>{maxAge}</span>
      </div>
    </BasicsShell>
  );
}

interface ChoiceOption {
  value: string;
  label: string;
  tone: BurstTone;
}

/**
 * The tap semantics shared by the two tap-to-answer screens. Unlike the other
 * three there is no Continue pill here — the option IS the action — so the tap
 * gets a reaction of its own: a burst of objects themed to what was picked,
 * thrown from the point the finger landed on (`onboarding-burst.ts`). It is
 * decoration only, and never gates the save.
 */
function useChoiceTap(
  onPick: (value: string) => void,
  /** Changing this clears the pop — see below. */
  resetKey: string,
): {
  firing: string | null;
  fire: (event: MouseEvent, value: string, tone: BurstTone) => void;
} {
  // Which option is mid-pop. Cleared when the user comes back to a screen they
  // already answered, so a stale value cannot light the wrong one on arrival.
  const [firing, setFiring] = useState<string | null>(null);
  useEffect(() => {
    setFiring(null);
  }, [resetKey]);

  const fire = useCallback(
    (event: MouseEvent, value: string, tone: BurstTone): void => {
      setFiring(value);
      // A crisper tap than the selection tick the save fires on success: this
      // one lands with the burst, not a round-trip later.
      app?.HapticFeedback?.impactOccurred("medium");
      burstFromEvent(event, tone);
      onPick(value);
    },
    [onPick],
  );

  return { firing, fire };
}

/** Gender: two plain rows, the option's own label doing all the work. */
function ChoiceScreen(props: {
  title: string;
  options: ChoiceOption[];
  selected: string | null;
  busy: boolean;
  error: ReactNode;
  onPick: (value: string) => void;
}): ReactElement {
  const { firing, fire } = useChoiceTap(props.onPick, props.title);

  return (
    <BasicsShell title={props.title} error={props.error} modifier="ob-basics--choice">
      <div className="ob-choice-stack">
        {props.options.map((option) => (
          <button
            key={option.value}
            type="button"
            className={`ob-choice ob-choice--${option.tone} ${
              props.selected === option.value ? "is-selected" : ""
            } ${firing === option.value ? "is-firing" : ""}`}
            disabled={props.busy}
            aria-pressed={props.selected === option.value}
            onClick={(event) => fire(event, option.value, option.tone)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </BasicsShell>
  );
}

/**
 * "Who do you want to meet?" — the one screen in the set that shows the answer
 * rather than naming it.
 *
 * Men and women are two tall columns splitting the screen in half: a target big
 * enough to hit without aiming, and wide enough to carry photographs of the
 * people behind the choice. "Both" sits under them, deliberately smaller and
 * quieter — it is a real answer, not the headline one, and three equal rows
 * made it compete with the two that most people are actually choosing between.
 *
 * A second design was built alongside this one and compared against it behind a
 * `?v=` switch; the founder settled on this one on 2026-08-07 and the switch,
 * the review page and the other design's artwork were deleted with it. There is
 * one design here now, and the way to try another is a branch.
 */
function PreferenceScreen(props: {
  strings: OnboardingStrings;
  selected: string | null;
  busy: boolean;
  error: ReactNode;
  onPick: (value: string) => void;
}): ReactElement {
  const { strings } = props;
  const { firing, fire } = useChoiceTap(props.onPick, strings.basicsPreferenceTitle);

  // The right-hand column is the left one mirrored (preference-layout.ts).
  const art = useMemo(() => {
    const men = placeScatter(photoSet("men"), false);
    const women = placeScatter(photoSet("women"), true);
    // The RENDERED photographs, which is what the reveal has to count: the
    // scatter truncates to its slot count, and a photo left over in the folder
    // has no element to decode.
    return { men, women, sources: [...men, ...women].map(({ src }) => src) };
  }, []);
  const { revealed, gateFor } = useScatterReveal(art.sources);

  const column = (
    side: "men" | "women",
    scatter: PhotoScatter,
    label: string,
    tone: BurstTone,
  ) => (
    <PreferenceColumn
      scatter={scatter}
      revealed={revealed}
      gateFor={gateFor}
      label={label}
      tone={tone}
      selected={props.selected === side}
      busy={props.busy}
      firing={firing === side}
      onFire={(event) => fire(event, side, tone)}
    />
  );

  return (
    <BasicsShell
      title={strings.basicsPreferenceTitle}
      error={props.error}
      modifier="ob-basics--choice ob-basics--pref"
    >
      <div className="ob-pref-pair">
        {column("men", art.men, strings.basicsPreferenceMen, "male")}
        {column("women", art.women, strings.basicsPreferenceWomen, "female")}
      </div>
      <button
        type="button"
        className={`ob-pref-both ${props.selected === "both" ? "is-selected" : ""} ${
          firing === "both" ? "is-firing" : ""
        }`}
        disabled={props.busy}
        aria-pressed={props.selected === "both"}
        onClick={(event) => fire(event, "both", "neutral")}
      >
        {strings.basicsPreferenceBoth}
      </button>
    </BasicsShell>
  );
}

type PhotoScatter = { src: string; slot: ScatterSlot }[];

/**
 * Holds the whole scatter back until every photograph across BOTH columns is
 * decoded, then shows them together — preference-reveal.ts explains why the
 * tally spans the screen rather than a column or a single photo, and why the
 * warm-up above is the real fix and this only the insurance.
 *
 * Gated through a ref on `decode()`, not `onLoad`, for exactly the reason
 * `AppIcon` is (onboarding.tsx): a photograph already warmed by
 * `warmPreferencePhotos` can be decoded before React ever attaches a load
 * listener, and `onLoad` would then never fire at all — which would leave the
 * screen bare until the cap in the one case the warm-up was supposed to make
 * instant.
 */
function useScatterReveal(sources: readonly string[]): {
  revealed: boolean;
  /** Undefined for a photograph the tally was never given — see `revealTally`. */
  gateFor: (src: string) => ((img: HTMLImageElement | null) => void) | undefined;
} {
  const tally = useMemo(() => revealTally(sources), [sources]);
  // Nothing to wait for when there are no photographs at all.
  const [revealed, setRevealed] = useState(() => tally.outstanding === 0);

  // Built once per source list so each <img> keeps the same ref identity across
  // re-renders — a fresh closure would detach and re-attach the ref on every
  // render, re-running decode for no reason.
  const gates = useMemo(() => {
    const map = new Map<string, (img: HTMLImageElement | null) => void>();
    for (const src of sources) {
      map.set(src, (img) => {
        if (!img) return;
        const settle = (): void => {
          if (tally.settle(src)) setRevealed(true);
        };
        try {
          // Rejection settles too: one photograph that will never paint must
          // not keep the other eleven off the screen.
          void img.decode().then(settle, settle);
        } catch {
          // No decode() on this WebView — fall back to the browser's own
          // schedule rather than never revealing.
          settle();
        }
      });
    }
    return map;
  }, [sources, tally]);

  useEffect(() => {
    if (revealed) return;
    const timer = window.setTimeout(() => setRevealed(true), PREF_REVEAL_CAP_MS);
    return () => window.clearTimeout(timer);
  }, [revealed]);

  return {
    revealed,
    gateFor: useCallback((src: string) => gates.get(src), [gates]),
  };
}

/**
 * One half of the fork.
 *
 * The photos are decoration on top of a button: `alt=""` plus a `pointer-events`
 * block in CSS, so they are invisible to a screen reader and can never swallow
 * the tap — including the tiles that hang past the button's edge, which
 * otherwise would be a live target sitting outside the thing they belong to.
 * The label carries the accessible name on its own.
 *
 * The button fills whatever height the screen allows and scatters frames across
 * it — all but the label's own strip at the bottom, which the photos are
 * authored to stay out of (`maxCentreY`, preference-layout.ts).
 *
 * The scatter and its reveal come from the SCREEN, not from here: both columns
 * have to appear at the same instant, so neither may decide on its own when it
 * is ready (preference-reveal.ts).
 */
function PreferenceColumn(props: {
  scatter: PhotoScatter;
  revealed: boolean;
  gateFor: (src: string) => ((img: HTMLImageElement | null) => void) | undefined;
  label: string;
  tone: BurstTone;
  selected: boolean;
  busy: boolean;
  firing: boolean;
  onFire: (event: MouseEvent) => void;
}): ReactElement {
  return (
    <button
      type="button"
      className={`ob-pref-col ob-pref-col--${props.tone} ${
        props.selected ? "is-selected" : ""
      } ${props.firing ? "is-firing" : ""}`}
      disabled={props.busy}
      aria-pressed={props.selected}
      onClick={props.onFire}
    >
      <span
        className={`ob-pref-art ${props.revealed ? "is-ready" : ""}`}
        aria-hidden="true"
      >
        {props.scatter.map(({ src, slot }) => (
          <span
            key={src}
            className="ob-pref-shot"
            style={{
              left: `${slot.x}%`,
              top: `${slot.y}%`,
              width: `${slot.w}%`,
              zIndex: slot.z,
              ["--rot" as string]: `${slot.rot}deg`,
            }}
          >
            <img ref={props.gateFor(src)} src={src} alt="" draggable={false} />
          </span>
        ))}
      </span>
      <span className="ob-pref-label">{props.label}</span>
    </button>
  );
}

function HeightScreen(props: {
  strings: OnboardingStrings;
  limits: TelegramProfileLimits;
  initial: number;
  busy: boolean;
  error: ReactNode;
  onSubmit: (height: number) => void;
}): ReactElement {
  const { minHeightCm, maxHeightCm } = props.limits;
  const [height, setHeight] = useState(() =>
    clamp(props.initial, minHeightCm, maxHeightCm),
  );

  return (
    <BasicsShell
      title={props.strings.basicsHeightTitle}
      error={props.error}
      modifier="ob-basics--height"
      action={
        <ContinuePill
          label={props.busy ? props.strings.saving : props.strings.continue}
          disabled={props.busy}
          onClick={() => props.onSubmit(height)}
        />
      }
    >
      <Wheel
        min={minHeightCm}
        max={maxHeightCm}
        value={height}
        unit={props.strings.basicsHeightUnit}
        label={props.strings.basicsHeightTitle}
        onChange={setHeight}
      />
    </BasicsShell>
  );
}

/**
 * The height drum.
 *
 * A scroll-snapping column rather than a pointer-drag simulation: the browser
 * supplies momentum, rubber-banding and snap for free, and they feel right on
 * both iOS and Telegram Desktop, which a hand-rolled version never quite does.
 * The centred capsule and the top/bottom fade are painted over it (see
 * `.ob-wheel-*` in onboarding.css), so the numbers ease in and out of the frame
 * instead of being clipped at a hard edge.
 */
function Wheel(props: {
  min: number;
  max: number;
  value: number;
  unit: string;
  label: string;
  onChange: (value: number) => void;
}): ReactElement {
  const { min, max, value, onChange } = props;
  const listRef = useRef<HTMLDivElement>(null);
  const settleRef = useRef<number | null>(null);
  // Guards the scroll handler while we are the ones moving the list, so
  // programmatic centring can't be read back as a user pick.
  const selfScrollRef = useRef(false);
  // Which value last pulsed, and when. The tick fires as each row passes under
  // the capsule, not when the drum finally stops: on a real picker the tick IS
  // how you count rows while your eyes are on the number, and a drum that only
  // buzzes once at the end feels like a list that happened to land somewhere.
  const tickedRef = useRef(value);
  const tickedAtRef = useRef(0);

  const values = useMemo(
    () => Array.from({ length: max - min + 1 }, (_, index) => min + index),
    [min, max],
  );

  const scrollToValue = useCallback(
    (next: number, smooth: boolean): void => {
      const list = listRef.current;
      if (!list) return;
      selfScrollRef.current = true;
      // Nothing crossed under the user's finger, so re-arm the tick tracker at
      // the destination — otherwise the first real scroll afterwards pulses for
      // a row that was never passed.
      tickedRef.current = next;
      list.scrollTo({
        top: (next - min) * WHEEL_ITEM_H,
        behavior: smooth && !prefersReducedMotion() ? "smooth" : "auto",
      });
      window.setTimeout(() => {
        selfScrollRef.current = false;
      }, 320);
    },
    [min],
  );

  // Open centred on the current value; no animation, it should already be
  // there. Mount only ON PURPOSE — later changes are either the user's own
  // scroll (the list is already in position, and re-scrolling it would fight
  // their finger) or a keyboard step, which scrolls itself.
  const openedRef = useRef(false);
  useEffect(() => {
    if (openedRef.current) return;
    openedRef.current = true;
    scrollToValue(value, false);
  }, [scrollToValue, value]);

  const handleScroll = useCallback((): void => {
    const list = listRef.current;
    if (!list || selfScrollRef.current) return;

    const centred = wheelValueAt(list.scrollTop, min, max);
    const now = Date.now();
    if (shouldTickHaptic(tickedRef.current, centred, tickedAtRef.current, now)) {
      tickedRef.current = centred;
      tickedAtRef.current = now;
      app?.HapticFeedback?.selectionChanged?.();
    }

    // The value itself is still committed on settle rather than per row: the
    // list re-renders every option on a change, and doing that on each scroll
    // frame is exactly the jank a native scroll was chosen to avoid.
    if (settleRef.current !== null) window.clearTimeout(settleRef.current);
    settleRef.current = window.setTimeout(() => {
      const next = wheelValueAt(list.scrollTop, min, max);
      if (next !== value) onChange(next);
    }, 90);
  }, [min, max, value, onChange]);

  useEffect(
    () => () => {
      if (settleRef.current !== null) window.clearTimeout(settleRef.current);
    },
    [],
  );

  const step = useCallback(
    (delta: number): void => {
      const next = clamp(value + delta, min, max);
      if (next === value) return;
      onChange(next);
      scrollToValue(next, true);
    },
    [value, min, max, onChange, scrollToValue],
  );

  return (
    <div className="ob-wheel">
      <div className="ob-wheel-capsule" aria-hidden="true">
        <span className="ob-wheel-unit">{props.unit}</span>
      </div>
      <div
        ref={listRef}
        className="ob-wheel-list"
        role="listbox"
        aria-label={props.label}
        aria-activedescendant={`ob-wheel-${value}`}
        tabIndex={0}
        onScroll={handleScroll}
        onKeyDown={(event) => {
          if (event.key === "ArrowUp") {
            event.preventDefault();
            step(-1);
          } else if (event.key === "ArrowDown") {
            event.preventDefault();
            step(1);
          }
        }}
      >
        <div className="ob-wheel-pad" aria-hidden="true" />
        {values.map((item) => (
          <div
            key={item}
            id={`ob-wheel-${item}`}
            role="option"
            aria-selected={item === value}
            className={`ob-wheel-item ${item === value ? "is-active" : ""}`}
          >
            {item}
          </div>
        ))}
        <div className="ob-wheel-pad" aria-hidden="true" />
      </div>
    </div>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}
