import { describe, expect, it } from "vitest";
// `?raw` rather than an import: `apps/webapp` deliberately does not depend on
// `@gennety/shared`, so the tap-screen list is a copy and this is what holds it
// to the original.
import SHARED_SCREENS from "../../../packages/shared/src/pulse-screens.ts?raw";
import ONBOARDING_SRC from "./onboarding.tsx?raw";
import {
  PULSE_BATCH_MAX,
  PULSE_QUEUE_MAX,
  PULSE_TAP_SCREENS,
  PulseTracker,
  classifyTapTarget,
  isDemoBuild,
  normalizeCoord,
  type PulseConsent,
  type PulseNode,
  type PulseSendResult,
} from "./pulse.js";

interface Sent {
  body: { installId: string; platform: string; events: Array<{ type: string; props: Record<string, unknown> }> };
  keepalive: boolean;
}

function harness(
  consent: PulseConsent,
  reply: (n: number) => PulseSendResult | Error = () => ({ status: 200 }),
  storedInstallId: string | null = null,
) {
  let clock = 1_000_000;
  let ids = 0;
  const sent: Sent[] = [];
  const persisted: string[] = [];
  const tracker = new PulseTracker(
    {
      now: () => clock,
      uuid: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
      session: "11111111-1111-4111-8111-111111111111",
      storedInstallId,
      app: { version: "0.1.0", build: "202610151200", os: "ios", locale: "ru" },
      persist: (installId) => persisted.push(installId),
      send: async (body, keepalive) => {
        sent.push({ body: JSON.parse(body) as Sent["body"], keepalive });
        const answer = reply(sent.length);
        if (answer instanceof Error) throw answer;
        return answer;
      },
    },
    consent,
  );
  return {
    tracker,
    sent,
    persisted,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

function node(tagName: string, attrs: Record<string, string> = {}, parent: PulseNode | null = null): PulseNode {
  return {
    tagName,
    getAttribute: (name) => attrs[name] ?? null,
    hasAttribute: (name) => name in attrs,
    parentElement: parent,
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("consent gating", () => {
  it("holds events in memory while pending and sends nothing, not even the install id", async () => {
    const h = harness("pending");
    h.tracker.navigate("mini_onb_language");
    h.tracker.navigate("mini_onb_consent");
    await h.tracker.flush();
    expect(h.sent).toHaveLength(0);
    expect(h.persisted).toHaveLength(0);
    expect(h.tracker.pending.map((e) => e.type)).toEqual(["screen_view", "screen_left", "screen_view"]);
  });

  it("sends the held queue once consent is given, and persists the install id then", async () => {
    const h = harness("pending");
    h.tracker.navigate("mini_onb_language");
    h.tracker.setConsent(true);
    await settle();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.body.platform).toBe("miniapp");
    expect(h.sent[0]!.body.events[0]!.type).toBe("screen_view");
    expect(h.persisted).toHaveLength(1);
    expect(h.tracker.pending).toHaveLength(0);
  });

  it("wipes the queue on a refusal and drops every later event", async () => {
    const h = harness("pending");
    h.tracker.navigate("mini_onb_language");
    h.tracker.setConsent(false);
    h.tracker.navigate("mini_onb_consent");
    h.tracker.setConsent(true); // a refusal is final for this page load
    await h.tracker.flush();
    expect(h.sent).toHaveLength(0);
    expect(h.tracker.pending).toHaveLength(0);
    expect(h.persisted).toHaveLength(0);
  });

  it("stops for the page load when the server answers consent:false", async () => {
    const h = harness("server", () => ({ status: 200, consent: false }));
    h.tracker.navigate("mini_calendar");
    await h.tracker.flush();
    expect(h.sent).toHaveLength(1);
    expect(h.tracker.isStopped).toBe(true);
    expect(h.persisted).toHaveLength(0);
    h.tracker.leave("dismiss");
    await h.tracker.flush(true);
    expect(h.sent).toHaveLength(1);
  });

  it("stops silently on 404 (feature flag off)", async () => {
    const h = harness("server", () => ({ status: 404 }));
    h.tracker.navigate("mini_premium");
    await h.tracker.flush();
    expect(h.tracker.isStopped).toBe(true);
    expect(h.tracker.pending).toHaveLength(0);
  });

  it("persists the install id in server mode only after an accepted batch", async () => {
    const h = harness("server");
    h.tracker.navigate("mini_calendar");
    expect(h.persisted).toHaveLength(0);
    await h.tracker.flush();
    expect(h.persisted).toHaveLength(1);
  });

  it("reuses an install id already on disk", async () => {
    const h = harness("server", undefined, "stored-install");
    h.tracker.navigate("mini_calendar");
    await h.tracker.flush();
    expect(h.sent[0]!.body.installId).toBe("stored-install");
  });
});

describe("queue", () => {
  it("splits into batches of at most 50", async () => {
    const h = harness("server");
    h.tracker.navigate("mini_onb_city");
    for (let i = 0; i < 120; i += 1) h.tracker.pointer(10, 10, 100, 100, { kind: "dead" });
    await h.tracker.flush();
    expect(h.sent.map((s) => s.body.events.length)).toEqual([PULSE_BATCH_MAX, PULSE_BATCH_MAX, 21]);
  });

  it("keeps a failed batch for the next tick, in order", async () => {
    const h = harness("server", (n) => (n === 1 ? new Error("offline") : { status: 200 }));
    h.tracker.navigate("mini_calendar");
    await h.tracker.flush();
    expect(h.tracker.pending).toHaveLength(1);
    h.tracker.navigate("mini_premium");
    await h.tracker.flush();
    expect(h.sent[1]!.body.events.map((e) => e.type)).toEqual(["screen_view", "screen_left", "screen_view"]);
  });

  it("is capped, dropping the oldest", () => {
    const h = harness("pending");
    h.tracker.navigate("mini_onb_city");
    for (let i = 0; i < PULSE_QUEUE_MAX + 20; i += 1) h.tracker.pointer(1, 1, 100, 100, { kind: "dead" });
    expect(h.tracker.pending).toHaveLength(PULSE_QUEUE_MAX);
    expect(h.tracker.pending[0]!.type).toBe("dead_tap");
  });

  it("sends keepalive batches on unload without awaiting", async () => {
    const h = harness("server");
    h.tracker.navigate("mini_calendar");
    h.tracker.leave("dismiss");
    await h.tracker.flush(true);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.keepalive).toBe(true);
  });
});

describe("screens", () => {
  it("counts only visible time as dwell and records the first action", () => {
    const h = harness("pending");
    h.tracker.navigate("mini_onb_consent");
    h.advance(1_000);
    h.tracker.pointer(50, 50, 100, 100, { kind: "control" });
    h.advance(1_000);
    h.tracker.setVisible(false);
    h.advance(60_000); // behind another chat — not thinking time
    h.tracker.setVisible(true);
    h.advance(500);
    h.tracker.navigate("mini_onb_path", "next");
    const left = h.tracker.pending.find((e) => e.type === "screen_left")!;
    expect(left.props).toEqual({ screen: "mini_onb_consent", exit: "next", dwell_ms: 2_500, first_action_ms: 1_000 });
    const view = h.tracker.pending.at(-1)!;
    expect(view.props).toEqual({ screen: "mini_onb_path", from: "mini_onb_consent" });
  });

  it("treats a repeat of the same key as no transition", () => {
    const h = harness("pending");
    h.tracker.navigate("mini_onb_basics");
    h.tracker.navigate("mini_onb_basics");
    expect(h.tracker.pending).toHaveLength(1);
  });

  it("records taps and dead taps only on tap screens; untagged controls are neither", () => {
    const h = harness("pending");
    h.tracker.navigate("mini_calendar");
    h.tracker.pointer(10, 10, 100, 100, { kind: "dead" });
    h.tracker.navigate("mini_onb_theme");
    h.tracker.pointer(33.3333, 50, 100, 200, { kind: "tap", element: "theme_dark" });
    h.tracker.pointer(10, 10, 100, 100, { kind: "control" });
    h.tracker.pointer(150, -5, 100, 100, { kind: "dead" });
    const taps = h.tracker.pending.filter((e) => e.type === "tap" || e.type === "dead_tap");
    expect(taps.map((e) => [e.type, e.props])).toEqual([
      ["tap", { screen: "mini_onb_theme", element: "theme_dark", x: 0.333, y: 0.25 }],
      ["dead_tap", { screen: "mini_onb_theme", x: 1, y: 0 }],
    ]);
  });
});

describe("normalizeCoord", () => {
  it("rounds to 3 decimals and clamps into 0…1", () => {
    expect(normalizeCoord(1, 3)).toBe(0.333);
    expect(normalizeCoord(2, 3)).toBe(0.667);
    expect(normalizeCoord(-4, 100)).toBe(0);
    expect(normalizeCoord(400, 100)).toBe(1);
    expect(normalizeCoord(10, 0)).toBe(0);
  });
});

describe("classifyTapTarget", () => {
  it("names a tap by the nearest data-pulse, even inside a control", () => {
    const button = node("BUTTON", { "data-pulse": "continue" });
    expect(classifyTapTarget(node("SPAN", {}, button))).toEqual({ kind: "tap", element: "continue" });
    const label = node("LABEL", { "data-pulse": "terms" });
    expect(classifyTapTarget(node("INPUT", {}, label))).toEqual({ kind: "tap", element: "terms" });
  });

  it("treats an untagged interactive ancestor as a control", () => {
    for (const control of [
      node("A"),
      node("button"),
      node("SELECT"),
      node("TEXTAREA"),
      node("LABEL"),
      node("DIV", { role: "button" }),
      node("DIV", { onclick: "" }),
    ]) {
      expect(classifyTapTarget(node("SPAN", {}, node("DIV", {}, control)))).toEqual({ kind: "control" });
    }
  });

  it("calls a touch on plain content a dead tap", () => {
    expect(classifyTapTarget(node("P", {}, node("SECTION", {}, node("BODY"))))).toEqual({ kind: "dead" });
    expect(classifyTapTarget(null)).toEqual({ kind: "dead" });
  });

  it("ignores a data-pulse value outside the server grammar", () => {
    expect(classifyTapTarget(node("DIV", { "data-pulse": "Not Valid!" }))).toEqual({ kind: "dead" });
  });
});

describe("demo", () => {
  it("recognises the demo bundle by its API base", () => {
    expect(isDemoBuild("https://demo-api.gennety.com")).toBe(true);
    expect(isDemoBuild("https://dating-api.gennety.com")).toBe(false);
    expect(isDemoBuild("")).toBe(false);
  });
});

describe("drift against packages/shared/src/pulse-screens.ts", () => {
  const entries = [...SHARED_SCREENS.matchAll(/^\s+(mini_[a-z_]+): \{([^\n]*)\},?$/gm)];

  it("mirrors exactly the Mini App screens that track taps", () => {
    const shared = entries.filter(([, , body]) => body!.includes("tracksTaps: true")).map(([, key]) => key);
    expect(shared.length).toBeGreaterThan(0);
    expect([...PULSE_TAP_SCREENS].sort()).toEqual(shared.sort());
  });

  it("every onboarding phase maps to a declared mini_onb_* key", () => {
    const declared = new Set(entries.map(([, key]) => key));
    const table = /const PULSE_PHASE_ORDER[^{]*\{([^}]*)\}/.exec(ONBOARDING_SRC)?.[1] ?? "";
    const phases = [...table.matchAll(/^\s+([a-zA-Z]+): \d+,$/gm)].map(([, kind]) => kind!);
    expect(phases.length).toBeGreaterThan(10);
    for (const kind of phases) {
      expect(declared.has(`mini_onb_${kind.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}`)).toBe(true);
    }
  });
});
