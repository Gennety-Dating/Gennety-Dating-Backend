import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import type { TelegramProfileBasics, TelegramProfileLimits, TelegramProfilePatch } from "./api.js";
import type { BasicsStep } from "./onboarding-basics-route.js";
import { errorCopy } from "./onboarding-errors.js";
import type { OnboardingStrings } from "./onboarding-i18n.js";

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

/** Height of one drum row, in px. Must match `.ob-wheel-item` in onboarding.css. */
const WHEEL_ITEM_H = 56;

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
        <ChoiceScreen
          title={strings.basicsPreferenceTitle}
          busy={busy}
          error={errorNode}
          selected={basics.preference}
          options={[
            { value: "men", label: strings.basicsPreferenceMen, tone: "male" },
            { value: "women", label: strings.basicsPreferenceWomen, tone: "female" },
            { value: "both", label: strings.basicsPreferenceBoth, tone: "neutral" },
          ]}
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
  title: string;
  error: ReactNode;
  children: ReactNode;
  /** Omitted on the tap-to-answer screens, where the option IS the action. */
  action?: ReactNode;
  modifier?: string;
}): ReactElement {
  return (
    <main className={`ob-basics ${props.modifier ?? ""}`}>
      <h1 className="ob-basics-title">{props.title}</h1>
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
      title={props.strings.basicsNameTitle}
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
  tone: "male" | "female" | "neutral";
}

function ChoiceScreen(props: {
  title: string;
  options: ChoiceOption[];
  selected: string | null;
  busy: boolean;
  error: ReactNode;
  onPick: (value: string) => void;
}): ReactElement {
  return (
    <BasicsShell title={props.title} error={props.error} modifier="ob-basics--choice">
      <div className="ob-choice-stack">
        {props.options.map((option) => (
          <button
            key={option.value}
            type="button"
            className={`ob-choice ob-choice--${option.tone} ${
              props.selected === option.value ? "is-selected" : ""
            }`}
            disabled={props.busy}
            aria-pressed={props.selected === option.value}
            onClick={() => props.onPick(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </BasicsShell>
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

  const values = useMemo(
    () => Array.from({ length: max - min + 1 }, (_, index) => min + index),
    [min, max],
  );

  const scrollToValue = useCallback(
    (next: number, smooth: boolean): void => {
      const list = listRef.current;
      if (!list) return;
      selfScrollRef.current = true;
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
    if (settleRef.current !== null) window.clearTimeout(settleRef.current);
    settleRef.current = window.setTimeout(() => {
      const index = Math.round(list.scrollTop / WHEEL_ITEM_H);
      const next = clamp(min + index, min, max);
      if (next !== value) {
        app?.HapticFeedback?.selectionChanged();
        onChange(next);
      }
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
