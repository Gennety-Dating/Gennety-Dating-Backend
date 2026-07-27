// Read-only production readiness report. Answers one question: "is production
// healthy, and is it safe to point ads at it?"
//
// STRICTLY READ-ONLY. It talks to the admin analytics API and the public health
// endpoints over HTTPS and never opens a database connection, so it cannot
// mutate production no matter how it is invoked. This is deliberate: it is the
// companion tool for PROD_TEST_PLAN.md, where the whole point is that verifying
// production must not change it.
//
// Usage:
//   export ADMIN_API_KEY="$(ssh root@167.172.178.229 \
//     'sed -n "s/^ADMIN_API_KEY=//p" /opt/gennety/.env | tail -1 | tr -d "\""')"
//   pnpm prod:status           # human-readable report
//   pnpm prod:status --json    # machine-readable
//
// Exit codes: 0 = healthy and launch-ready; 2 = launch blockers present;
// 1 = misconfiguration / connectivity error.
//
// The key is read from the environment and never printed, not even in an error
// path — it rides in an Authorization header, never a query string or a URL.

const ADMIN_BASE = process.env.PROD_ADMIN_BASE ?? "https://api-admin.gennety.com";
const PUBLIC_BASE = process.env.PROD_PUBLIC_BASE ?? "https://dating-api.gennety.com";
const WEBAPP_BASE = process.env.PROD_WEBAPP_BASE ?? "https://dating-calendar.gennety.com";

const asJson = process.argv.includes("--json");
const key = process.env.ADMIN_API_KEY;

if (!key) {
  console.error(
    "prod:status: ADMIN_API_KEY is not set. Export it first, e.g.\n" +
      "  export ADMIN_API_KEY=\"$(ssh root@167.172.178.229 " +
      "'sed -n \"s/^ADMIN_API_KEY=//p\" /opt/gennety/.env | tail -1 | tr -d \\\"\\\\\\\"\\\"')\"",
  );
  process.exit(1);
}

// Telegram ids that are known-synthetic fixtures rather than real humans. They
// are `active` but carry no Profile/email, so the matching hard filters exclude
// them — their real cost is polluting the active count and generating a
// permanent `status-banner … chat not found` error every cycle.
const SEED_TELEGRAM_IDS = new Set(["901001", "901002"]);

const TIMEOUT_MS = 25_000;

const MINI_APPS = [
  "index.html",
  "feedback.html",
  "location.html",
  "onboarding.html",
  "verification.html",
  "ticket.html",
  "tickets.html",
  "venue-change.html",
  "premium.html",
  "radar.html",
  "referral.html",
];

async function get(url, { auth = false, json = true } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: auth ? { Authorization: `Bearer ${key}` } : {},
    });
    if (!json) return { status: res.status };
    if (!res.ok) return { status: res.status, error: `HTTP ${res.status}` };
    return { status: res.status, body: await res.json() };
  } catch (err) {
    // Never interpolate the request headers here — only the URL, which carries
    // no secret.
    return { status: 0, error: err.name === "AbortError" ? "timeout" : String(err.message ?? err) };
  } finally {
    clearTimeout(timer);
  }
}

const admin = (path) => get(`${ADMIN_BASE}${path}`, { auth: true });

// The /admin/users response shape has varied; accept a bare array or a wrapper.
function rowsOf(body) {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.users)) return body.users;
  if (Array.isArray(body?.data)) return body.data;
  return [];
}

const [audience, cities, verification, dates, growth, users, ping, adminNoAuth] =
  await Promise.all([
    admin("/admin/analytics/audience"),
    admin("/admin/analytics/cities"),
    admin("/admin/analytics/verification"),
    admin("/admin/analytics/dates"),
    admin("/admin/analytics/growth"),
    admin("/admin/users?limit=200"),
    get(`${PUBLIC_BASE}/v1/ping`),
    get(ADMIN_BASE, { json: false }),
  ]);

const miniApps = await Promise.all(
  MINI_APPS.map(async (page) => ({
    page,
    status: (await get(`${WEBAPP_BASE}/${page}`, { json: false })).status,
  })),
);

const connectivityError = [audience, cities, verification, dates, growth, users].find(
  (r) => r.error,
);
if (connectivityError) {
  console.error(`prod:status: admin API unreachable — ${connectivityError.error}`);
  console.error(`  base: ${ADMIN_BASE} (401 here means the key is wrong)`);
  process.exit(1);
}

const userRows = rowsOf(users.body);
const activeUsers = userRows.filter((u) => u.status === "active");
const seedAccounts = userRows.filter((u) => SEED_TELEGRAM_IDS.has(String(u.telegramId)));
const activeSeeds = seedAccounts.filter((u) => u.status === "active");

// A city can only produce matches if it holds both genders. This is the single
// most load-bearing launch signal: ads that bring one gender into a city with
// none of the other produce a no-match DM for every user.
const cityRows = cities.body?.cities ?? [];
const lopsidedCities = cityRows
  .filter((c) => c.cityKey !== "unknown" && c.total > 0)
  .filter((c) => c.male === 0 || c.female === 0);

const brokenMiniApps = miniApps.filter((m) => m.status !== 200);
const pingOk = ping.body?.ok === true;
const adminGuarded = adminNoAuth.status === 401;

const blockers = [];
const warnings = [];

if (!pingOk) blockers.push(`public API /v1/ping is not ok (status ${ping.status})`);
if (!adminGuarded)
  blockers.push(`admin API answered ${adminNoAuth.status} without auth — expected 401`);
if (brokenMiniApps.length)
  blockers.push(
    `Mini App page(s) not serving: ${brokenMiniApps.map((m) => `${m.page}=${m.status}`).join(", ")}`,
  );

if (activeSeeds.length)
  blockers.push(
    `${activeSeeds.length} synthetic seed account(s) still active: ` +
      `${activeSeeds.map((u) => `${u.firstName ?? "?"}(tg=${u.telegramId})`).join(", ")} — ` +
      `PROD_TEST_PLAN.md §1.1`,
  );

for (const c of lopsidedCities) {
  warnings.push(
    `${c.city}: ${c.male} male / ${c.female} female — no pair can be formed here ` +
      `(PROD_TEST_PLAN.md §7)`,
  );
}

if (activeUsers.length)
  warnings.push(
    `${activeUsers.length} account(s) in the matching pool: ` +
      `${activeUsers.map((u) => `${u.firstName ?? "?"}(tg=${u.telegramId})`).join(", ")} — ` +
      `freeze test accounts before ads (§6.1)`,
  );

const report = {
  generatedAt: new Date().toISOString(),
  health: {
    publicApi: pingOk ? "ok" : `FAIL(${ping.status})`,
    adminAuthGuard: adminGuarded ? "ok (401)" : `FAIL(${adminNoAuth.status})`,
    miniApps: `${miniApps.length - brokenMiniApps.length}/${miniApps.length} serving 200`,
  },
  users: {
    total: audience.body?.totalUsers ?? userRows.length,
    byStatus: growth.body?.health?.statusCounts ?? {},
    active: activeUsers.length,
    dormantActive: growth.body?.health?.dormantActive ?? null,
  },
  verification: verification.body?.funnel ?? {},
  matching: {
    matchesEver: growth.body?.acquisition?.bySource?.reduce((n, s) => n + (s.matched ?? 0), 0) ?? 0,
    datesScheduled: dates.body?.scheduledCount ?? 0,
    datesCompleted: dates.body?.completedCount ?? 0,
    datesCancelled: dates.body?.cancelledCount ?? 0,
  },
  cities: cityRows.map((c) => ({
    city: c.city,
    total: c.total,
    male: c.male,
    female: c.female,
  })),
  seedAccounts: seedAccounts.map((u) => ({
    telegramId: String(u.telegramId),
    firstName: u.firstName,
    status: u.status,
  })),
  blockers,
  warnings,
  launchReady: blockers.length === 0,
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(blockers.length ? 2 : 0);
}

const h = (s) => `\n\x1b[1m${s}\x1b[0m`;
const ok = (s) => `\x1b[32m${s}\x1b[0m`;
const bad = (s) => `\x1b[31m${s}\x1b[0m`;
const warn = (s) => `\x1b[33m${s}\x1b[0m`;

console.log(h("PRODUCTION STATUS") + `  ${report.generatedAt}`);

console.log(h("Health"));
console.log(`  public /v1/ping     ${pingOk ? ok("ok") : bad(report.health.publicApi)}`);
console.log(`  admin auth guard    ${adminGuarded ? ok("401 (guarded)") : bad(report.health.adminAuthGuard)}`);
console.log(
  `  Mini Apps           ${brokenMiniApps.length ? bad(report.health.miniApps) : ok(report.health.miniApps)}`,
);

console.log(h("Users"));
console.log(`  total               ${report.users.total}`);
console.log(
  `  by status           ${Object.entries(report.users.byStatus).map(([k, v]) => `${k}=${v}`).join("  ") || "—"}`,
);
console.log(`  in matching pool    ${report.users.active}`);

console.log(h("Verification funnel"));
console.log(
  `  ${Object.entries(report.verification).map(([k, v]) => `${k}=${v}`).join("  ") || "—"}`,
);

console.log(h("Matching & dates"));
console.log(`  matches ever        ${report.matching.matchesEver}`);
console.log(
  `  dates               scheduled=${report.matching.datesScheduled}  completed=${report.matching.datesCompleted}  cancelled=${report.matching.datesCancelled}`,
);

console.log(h("Cities (gender balance decides whether matching is possible)"));
for (const c of report.cities) {
  const line = `  ${c.city.padEnd(12)} total=${String(c.total).padEnd(4)} male=${String(c.male).padEnd(4)} female=${c.female}`;
  console.log(c.male === 0 || c.female === 0 ? warn(line) : line);
}

if (blockers.length) {
  console.log(h(bad("BLOCKERS — do not start ads")));
  for (const b of blockers) console.log(bad(`  ✗ ${b}`));
}

if (warnings.length) {
  console.log(h(warn("Warnings")));
  for (const w of warnings) console.log(warn(`  ! ${w}`));
}

if (!blockers.length && !warnings.length) console.log(h(ok("No blockers, no warnings.")));

console.log(
  h(report.launchReady ? ok("LAUNCH-READY") : bad("NOT LAUNCH-READY")) +
    `  (see PROD_TEST_PLAN.md §7)\n`,
);

process.exit(blockers.length ? 2 : 0);
