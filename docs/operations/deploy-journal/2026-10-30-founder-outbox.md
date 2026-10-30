<!-- WHEN_TO_READ: Checking the 2026-10-30 founder transport/workspace reliability deployment. -->
# 2026-10-30 — founder transport outbox

Production deployed: only founder-notify, its new founder-outbox module and
startup registration; package/lockfile Vite override patched to 6.4.5.
The four pre-existing production files matched local HEAD by SHA-256 before
replacement. Rollback source archive:
`/opt/gennety-workbot-backup-20261030-084957/code.tar`.

No schema or feature-flag change. `pnpm db:drift-check` passed; five foreign
canvas tables left untouched. `pnpm install --frozen-lockfile --prefer-offline`
completed. `pm2 restart gennety-bot --update-env` and `pm2 save` completed;
process online, public `/health` returned 200; outbox directory 0700, empty
at verification. No synthetic production message or payment was generated.

Local verification: 7,592 bot tests passed (474 files), package build passed,
33 focused founder/outbox/API-limit tests passed, TypeScript passed,
secret check and dependency audit passed. The first full test run inherited
local `selfies-dev`/`voice-prompts-dev` buckets and failed six hard-coded
mock expectations. Running the same suite with process-only test fixture
bucket values passed; no dev/prod credential or env file was changed.

The Mac work-bot remains local by explicit owner choice. Its independent
65-test suite and real read-only API smoke test passed. Encrypted restic
repository is on a dedicated restricted SFTP account on the existing droplet;
restore of all 65 workspace rows and files was tested. A separate systemd
monitor timer checks the Mac's public health every five minutes; initial
state healthy. Sleeping Mac still makes local workspace unavailable.

Demo/dev founder suppression is unchanged. The durable transport is
at-least-once, not an exactly-once event ledger: preparation before the API
request is still best-effort and ambiguous Telegram timeouts may duplicate a
notification. Pending payloads include personal data, stay mode 0600 inside
0700, are removed after successful delivery and must never be copied into logs.

Rollback: restore the code archive, remove the new startup registration by
restoring index.ts, install the restored lockfile and restart/save PM2. Preserve
`/var/lib/gennety-founder-outbox` across rollback for later replay; do not delete
unsent payloads. Workspace rollback uses its separate pre-upgrade source/DB
snapshot; keep a copy of the newer SQLite database rather than overwriting
new user messages with an older snapshot.
