## Redirect to Main Project Files

This file is the entry point for **Claude Code**.  
The project is documented across three files:

- **AGENTS.md** — Tech stack, commands, code style, boundaries (rules for the AI developer)
- **PRODUCT_SPEC.md** — Product logic, user flow, core principles (what the app does)
- **ARCHITECTURE.md** — Database schema, Mermaid diagram, system architecture (how it's built)

Claude Code should always import and follow:

@AGENTS.md
@PRODUCT_SPEC.md
@ARCHITECTURE.md

## Claude-specific Rules

- Always start complex tasks (FSM, onboarding pipeline, match engine, scheduling logic, etc.) in **Plan Mode**: propose a short plan (max 4–5 steps), show it to the user and wait for confirmation before editing any files.
- Prefer small, file-scoped changes and the test-first approach.
- Use Claude’s auto-memory to remember project-specific best practices (e.g. optimal usage of `sendMessageDraft`, DeviceStorage in React Mini App, Prisma + pgvector patterns).
- When working with Telegram Bot API 9.5+, always verify the latest methods at core.telegram.org/bots/api.
- If the user requests anything that violates the Core Principles in PRODUCT_SPEC.md (Zero-Chat rule, corporate email verification, no in-app chat, etc.) — immediately refuse and clearly remind the rules.