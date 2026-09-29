/**
 * Stubs first (the terminal reads Telegram, fetch and the GPS at import), then
 * the real terminal, then — for `?t=` — the real overlay frozen at that time.
 */
const q = new URLSearchParams(location.search);
if (!q.has("match")) {
  q.set("match", "m1");
  q.set("lang", q.get("lang") ?? "ru");
  history.replaceState(null, "", `${location.pathname}?${q.toString()}`);
}
const VENUE = { lat: 50.4486, lng: 30.5133 };
const w = window as unknown as Record<string, unknown>;
w.Telegram = {
  WebApp: {
    initData: "lab",
    initDataUnsafe: {},
    safeAreaInset: { top: 62, bottom: 34, left: 0, right: 0 },
    contentSafeAreaInset: { top: 44, bottom: 0, left: 0, right: 0 },
    HapticFeedback: { impactOccurred() {}, notificationOccurred() {}, selectionChanged() {} },
    ready() {},
    expand() {},
    close() {},
    isVersionAtLeast: () => true,
  },
};
Object.defineProperty(navigator, "geolocation", {
  value: {
    watchPosition(ok: PositionCallback) {
      setTimeout(() => ok({ coords: { latitude: VENUE.lat, longitude: VENUE.lng } } as GeolocationPosition), 0);
      return 1;
    },
    clearWatch() {},
    getCurrentPosition(ok: PositionCallback) {
      ok({ coords: { latitude: VENUE.lat, longitude: VENUE.lng } } as GeolocationPosition);
    },
  },
});
// ?flow=hold — the hold long-polls 1.2 s, then answers with a ceremony
// (role from ?role, default A). ?flow=legacy — a server without the long-poll:
// the hold answers at once, unpaired; 2 s later the state reports the sync
// (the degrade path).
const flow = q.get("flow");
let verifiedAt: number | null = null;
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.includes("/bump") && init?.method === "POST") {
    const body = JSON.parse(String(init.body)) as { hold?: boolean };
    console.log("[lab] bump", JSON.stringify(body));
    if (flow === "legacy") {
      verifiedAt = Date.now() + 2_000;
      return new Response(JSON.stringify({ ok: true, verified: false, deck: null }), { status: 200 });
    }
    await new Promise((r) => setTimeout(r, 1_200));
    verifiedAt = Date.now();
    const role = q.get("role") === "B" ? "B" : "A";
    return new Response(
      JSON.stringify({
        ok: true,
        verified: true,
        deck: null,
        ceremony: { startAt: new Date(Date.now() + 900).toISOString(), role, serverNow: new Date().toISOString() },
      }),
      { status: 200 },
    );
  }
  if (url.includes("/v1/date/state")) {
    const synced = verifiedAt !== null && Date.now() >= verifiedAt;
    return new Response(
      JSON.stringify({
        state: synced ? "DATE_IN_PROGRESS" : "DATE_BUMP_PENDING",
        serverNow: new Date().toISOString(),
        nextDropAt: null,
        timeZone: "Europe/Kyiv",
        match: {
          id: "m1",
          agreedTime: new Date(Date.now() + 5 * 60_000).toISOString(),
          deadlineAt: null,
          venue: { name: "Kanapa", address: null, lat: VENUE.lat, lng: VENUE.lng, mapsUri: null },
          deck: synced ? ["Лучшее место в городе, где ты ни разу не был(а)?", "Что тебя сегодня удивило?", "Какой концерт ты бы пережил(а) ещё раз?"] : [],
          bump: { mine: verifiedAt !== null, verified: synced },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }
  return new Response("{}", { status: 404 });
};

const { createRoot } = await import("react-dom/client");
const { createElement } = await import("react");
await import("../../src/ticket/ticket.css");
await import("../../src/date-terminal/terminal.css");
const { DateTerminal } = await import("../../src/date-terminal/App.js");
const root = document.getElementById("root")!;
createRoot(root).render(createElement(DateTerminal));

const mode = q.get("mode");
const tParam = q.get("t");
if (mode === "waiting" || tParam !== null) {
  const { CeremonyOverlay } = await import("../../src/date-terminal/ceremony/CeremonyOverlay.js");
  const { ownDevice, planFor } = await import("../../src/date-terminal/ceremony/adapter.js");
  const { Render } = await import("../../src/date-terminal/ceremony/render-stand.js");
  const { stringsFor, pickLang } = await import("../../src/date-terminal/i18n.js");
  const s = stringsFor(pickLang(q.get("lang")));
  await document.fonts.ready;
  let capsule: Element | null = null;
  for (let i = 0; i < 100 && !capsule; i += 1) {
    capsule = document.querySelector(".hold-capsule");
    if (!capsule) await new Promise((r) => setTimeout(r, 30));
  }
  const rect = capsule?.getBoundingClientRect();
  const style = document.createElement("style");
  style.textContent = ".hold-capsule{visibility:hidden}";
  document.head.appendChild(style);
  const plan = planFor(ownDevice({ w: innerWidth, h: innerHeight, home: 34 }), {
    rm: q.get("rm") === "1",
    markDX: Render.plaqueMarkDX(s.ceremonyTitle, s.ceremonySub),
    ...(rect ? { capY: rect.top + rect.height / 2 } : {}),
  });
  const t = Number(tParam ?? 0);
  const host = document.createElement("div");
  document.body.appendChild(host);
  createRoot(host).render(
    createElement(CeremonyOverlay, {
      plan,
      scene: mode === "waiting" ? null : { role: q.get("role") === "A" ? "A" : "B", startAt: 0 },
      labels: { waiting: s.ceremonyWaiting, ready: s.ceremonyReady, title: s.ceremonyTitle, sub: s.ceremonySub },
      serverNow: () => t,
      onHaptic: () => {},
      onDone: () => {},
    }),
  );
}
