# DECISIONS.md — moved

The decision and deviation journal (238 entries, ~167k tokens) was being loaded
into every session through a `@DECISIONS.md` import in the root instruction
file. It is now
split by date. This stub stays because source comments and other docs reference
"DECISIONS.md" by name.

| You want | Read |
|---|---|
| "Was this already decided?" — searchable index of all 238 entries | [docs/architecture/decisions/INDEX.md](docs/architecture/decisions/INDEX.md) |
| The journal protocol (when to write, entry format) | [docs/architecture/decisions/README.md](docs/architecture/decisions/README.md) |
| The newest dated file (as of 2026-10-19: entries 2026-08-27 → 2026-10-02) | [docs/architecture/decisions/2026-08-27_2026-09-01.md](docs/architecture/decisions/2026-08-27_2026-09-01.md) — the top row of the table in [README.md](docs/architecture/decisions/README.md) |

**Recording a new decision?** Append to the newest dated file in
`docs/architecture/decisions/` and add one row to `INDEX.md`. If that file is
already over 1 MB (the one above is), start a new dated file
`docs/architecture/decisions/YYYY-MM-DD.md` (date of its first entry), list it
in the README table and update this stub.

**The rule has not changed:** anything decided in conversation and not written
down disappears with the context window. Still mandatory.
