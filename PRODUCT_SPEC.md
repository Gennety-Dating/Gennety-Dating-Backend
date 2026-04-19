# Gennety Dating — Product Specification

> **Version:** 1.8  
> Tech stack and coding rules are in [AGENTS.md](AGENTS.md).  
> Database schema and system architecture are in [ARCHITECTURE.md](ARCHITECTURE.md).

## Project Overview

Gennety Dating is an AI-first romantic matchmaking service targeting university students.
It diverges from traditional dating apps by relying on deep context extracted from users' personal LLMs (ChatGPT, Claude) and completely eliminating user-to-user text communication before the first date. The system acts as an ultimate AI matchmaker: it finds the match, proposes it, and negotiates the logistics.

## Core Principles (Strict Rules)

- **Hyper-Local Student Focus (Corporate Email)**: Users MUST register and verify a valid corporate university email domain (e.g., `.edu`, `.ac.uk`).
- **NO IN-APP CHAT**: Users NEVER message each other through our platform. Do not build chat interfaces.
- **Deep Context over Questionnaires**: Users provide a prompt to their personal LLM, which generates their deep psychological profile.
- **Progressive Logistics**: The AI attempts to auto-schedule first. If it fails, users negotiate via Telegram Web App Calendar.
- **Native Telegram AI Experience**: Extensively use the latest Telegram Bot API features (v9.0 — v9.6), including AI message streaming (`sendMessageDraft`), custom UI emojis (`icon_custom_emoji_id`), and native date/time entities (`date_time`) to make the bot feel like a premium, native application.

## User Flow (State Machine)

### Phase 1: Onboarding Funnel (Strict Linear Sequence)

The Telegram bot MUST guide the user through this exact sequence using FSM:

1. **Language Selection**: `[English]` `[Русский]` `[Українська]`
2. **Philosophy Pitch**: `/start` -> Introduction to the "Zero-Chat" philosophy.
3. **Corporate University Verification**:
   - Ask for corporate university email, extract domain, send OTP via SMTP.
4. **Basic Info**: Ask for Display Name, Surname, and Age.
5. **Visual Screening (Preferences)**:
   - Bot sends carousels of men/women to identify visual traits.
   - The photo caption MUST use `custom_emoji` entities (👍/👎 icons via `CUSTOM_EMOJI_LIKE_ID` / `CUSTOM_EMOJI_DISLIKE_ID` env vars) when configured. **Note:** Telegram Bot API does not support `custom_emoji` entities on `InlineKeyboardButton` text — custom emoji are applied to the caption, while buttons use plain Unicode emoji as a reliable fallback.
6. **Personal Questionnaire / Context Extraction (LLM Dump)**:
   - Bot provides a pre-written prompt. User copies it, pastes it into their ChatGPT, and returns the context dump to the bot.
   - **API v9.5 Integration**: While the backend AI parses the JSON profile, the bot MUST use `sendMessageDraft` to stream the AI's internal monologue (e.g., "Analyzing your profile... Oh, you love jazz... Synthesizing psychological traits...") to create a live-AI feel.
7. **Photo Upload**: Bot processes Telegram `file_id`s. (Optional: basic AI face detection to ensure a real human photo is uploaded.)
8. **Profile Review (Finalization)**: User confirms `[Looks good!]`.

### Phase 2: Main Menu & Persistent Features

Once onboarded, the bot displays a persistent Menu. The menu title uses a `custom_emoji` entity for the 🎓 icon when `CUSTOM_EMOJI_MENU_ID` is configured. **Note:** Inline keyboard button labels cannot carry `custom_emoji` entities (Bot API limitation) — they use plain Unicode emoji as a fallback.

- **My Profile**: Shows generated bio.
- **Edit Profile**: Core identity data (Name, Age, University) are FIXED.
- **Pause Matching**: "Snooze" feature.
- **Settings**: Change Language.
- **Report/Help**: Contact support.

### Phase 3: Matching Engine & Progressive Scheduling

1. **The Match & Pitch**:
   - Cron job finds pairs on a weekly cadence: **Thursday at 18:00 Europe/Kyiv** (`MATCH_CRON_SCHEDULE = "0 18 * * 4"`, `CRON_TIMEZONE = "Europe/Kyiv"`).
   - A warm pre-match teaser goes out **24 hours earlier, on Wednesday at 18:00 Kyiv** (`PRE_MATCH_ANNOUNCE_CRON_SCHEDULE = "0 18 * * 3"`).
   - **API v9.5 Integration**: The bot uses `sendMessageDraft` to stream the personalized pitch to both users in real-time, making the matchmaking feel dynamic and bespoke.
   - Buttons: `[Accept]` / `[Decline]`.
2. **Rejection Feedback**: If `[Decline]` is clicked, the bot prompts the user to type a reason. AI parses this and updates negative constraints.
3. **Progressive Scheduling (If both Accept)**:
   - **Iteration 1 & 2 (AI Proposals)**: Bot proposes AI-generated times.
   - **Iteration 3 (Telegram Web App Calendar)**: User opens Mini App. The Mini App uses `DeviceStorage` (API v9.0) to temporarily cache user selections so data isn't lost if they accidentally close the swipe-down window.
4. **Venue Selection (API Driven)**:
   - Backend queries Places API near the university or midpoint.
   - **API v9.5 Integration**: The final confirmation message MUST use the `date_time` message entity. This ensures the date (e.g., "Friday at 19:00") is automatically formatted into the user's local timezone and clickable in their Telegram client.

### Phase 4: Emergency Protocol & The Date

1. **Ice-breakers**: Sent 3 hours before date.
2. **Emergency Protocol**: 3 hours before date, menu unlocks. User MUST write explanation. Bot forwards EXACT text to the other person.
3. **Feedback Loop**: Next day bot asks for feedback.
