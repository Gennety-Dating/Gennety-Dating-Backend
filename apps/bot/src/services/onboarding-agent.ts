import { prisma, Prisma, type Language } from "@gennety/db";
import { openaiFetch } from "./openai-fetch.js";
import { grantStudentBonusIfEligible } from "./ticket-wallet.js";
import {
  isUniversityEmail,
  MIN_PHOTOS,
  MAX_PHOTOS,
  MIN_AGE,
  MAX_AGE,
  ALLOWED_EMAIL_DOMAINS,
  MAX_HISTORY_FOR_API,
  SUMMARIZE_THRESHOLD,
  KEEP_RECENT_MESSAGES,
  contextDumpInstruction,
  magicContextPrompt,
  PROFILER_ENTRY_DELAY_MS,
} from "@gennety/shared";
import { env } from "../config.js";
import {
  analyseAndSaveProfile,
  appendVibeToSummary,
  saveFallbackProfileAnalysis,
} from "./profile-analysis.js";
import { extractVibeAxes, saveVibeAxes } from "./vibe-axes.js";
import { createAndSendOtp, verifyOtp as verifyStoredOtp } from "../public/otp.js";
import {
  onboardingActivityPatch,
  reEngagementStopPatch,
} from "../workers/re-engagement-schedule.js";
import {
  collectOnboardingInput,
  markOnboardingField,
  onboardingNotUnderstoodText,
  onboardingQuestionText,
  onboardingValidationText,
  type CollectorDeps,
  type OnboardingField,
  type OnboardingInput,
  type OnboardingQuestion,
} from "./onboarding-collector.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** OpenAI chat message (subset we use) */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface ChatCompletionResponse {
  choices: Array<{
    message: {
      role: "assistant";
      content: string | null;
      tool_calls?: ToolCall[];
    };
    finish_reason: string;
  }>;
}

/** Result returned to the bot handler after one agent turn */
export interface AgentTurnResult {
  reply: string;
  expectingPhoto: boolean;
  onboardingComplete: boolean;
  /** Server-confirmed onboarding fields saved during this turn. */
  acceptedOnboardingFields?: OnboardingField[];
  /**
   * When true, onboarding data is saved but the user is NOT yet activated —
   * the bot must send the Sumsub verification CTA and wait for the webhook
   * before matching is unlocked. False when Sumsub is not configured (local
   * dev) — in that case onboardingComplete implies the user is already active.
   */
  verificationRequired: boolean;
  /** When true, the handler must send MAGIC_CONTEXT_PROMPT in a code block after the reply */
  contextPromptRequested: boolean;
  /**
   * When true, the handler must switch the session into context-dump-buffering
   * mode so that the pasted response can be acknowledged and then sent to the
   * agent after a short processing delay.
   */
  contextDumpStarted: boolean;
  /**
   * When true, a context dump was parsed and saved in THIS turn. The handler
   * uses it to play the "analysing your profile" status sequence before the
   * follow-up reply (the photo request). Distinct from `contextDumpStarted`,
   * which fires when the Magic Prompt is first shown.
   */
  contextDumpSaved: boolean;
}

/** Injectable dependencies for testing */
export interface AgentDeps {
  fetchFn?: typeof fetch;
  sendOtp?: (to: string, otp: string) => Promise<void>;
  analyseProfile?: typeof analyseAndSaveProfile;
  saveFallbackProfile?: typeof saveFallbackProfileAnalysis;
  extractOnboardingFacts?: CollectorDeps["extractFacts"];
  extractVibeAxes?: typeof extractVibeAxes;
  saveVibeAxes?: typeof saveVibeAxes;
  appendVibeToSummary?: typeof appendVibeToSummary;
}

function normalizedOnboardingInput(input: string | OnboardingInput): OnboardingInput {
  return typeof input === "string" ? { kind: "user_text", text: input } : input;
}

async function appendCollectorHistory(
  telegramId: bigint,
  input: OnboardingInput,
  reply: string,
  includeMagicPrompt: boolean,
  onboardingComplete: boolean,
): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: { messageHistory: true, language: true },
  });
  const history = ((user?.messageHistory ?? []) as unknown[]).map(
    (message) => message as ChatMessage,
  );
  if (input.kind === "user_text" || input.kind === "context_dump") {
    history.push({ role: "user", content: input.text });
  }
  if (includeMagicPrompt) {
    history.push({
      role: "assistant",
      content: magicContextPrompt(user?.language ?? "en"),
    });
  }
  history.push({ role: "assistant", content: reply });
  const now = new Date();
  await prisma.user.update({
    where: { telegramId },
    data: {
      messageHistory: history as unknown as Prisma.InputJsonValue[],
      ...(onboardingComplete
        ? { lastMessageAt: now, ...reEngagementStopPatch }
        : onboardingActivityPatch(now)),
    },
  });
}

export async function recordOnboardingAssistantReply(
  telegramId: bigint,
  reply: string,
): Promise<void> {
  await appendCollectorHistory(
    telegramId,
    { kind: "resume" },
    reply,
    false,
    false,
  );
}

/**
 * Produce a short, warm clarification when the user asked a question instead
 * of answering an onboarding question. The canonical onboarding question is
 * re-posed by the caller, so this must NOT ask anything or restate it. Returns
 * null on any failure (no key, API error) so the caller falls back to simply
 * re-posing the question — never blocks the flow.
 */
async function generateClarificationReply(
  language: Language,
  question: OnboardingQuestion,
  userText: string,
  deps: AgentDeps,
  completedFields: readonly OnboardingField[] = [],
): Promise<string | null> {
  if (!env.OPENAI_API_KEY) return null;
  const fetchFn = deps.fetchFn ?? openaiFetch;
  const canonical = onboardingQuestionText(language, question, completedFields);
  try {
    const res = await fetchFn("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-5.4-mini",
        messages: [
          {
            role: "system",
            content:
              `You are Gennety's onboarding assistant for a student matchmaking service. ` +
              `The user is being asked this onboarding question: "${canonical}". ` +
              `Instead of answering, they replied with a question or confusion. ` +
              `Reply in language "${language}" with a warm, concise 1–2 sentence clarification that helps them answer. ` +
              `Do NOT ask a new question and do NOT restate the onboarding question — it is appended separately. Plain text, no markdown.`,
          },
          { role: "user", content: userText },
        ],
        temperature: 0.4,
        max_completion_tokens: 200,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: string | null } }>;
    };
    const text = body.choices?.[0]?.message?.content?.trim();
    return text && text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

async function runCollectorTurn(
  telegramId: bigint,
  input: OnboardingInput,
  deps: AgentDeps,
): Promise<AgentTurnResult> {
  let contextDumpSaved = false;
  let snapshot;

  if (input.kind === "context_dump") {
    const saved = await execSaveContextDump(
      telegramId,
      {},
      deps,
      input.text,
    );
    const parsed = parseJsonObject(saved);
    if (parsed?.success !== true) {
      const fallback =
        typeof parsed?.error === "string"
          ? parsed.error
          : "I couldn't process that AI context. Please send the full response again.";
      await appendCollectorHistory(telegramId, input, fallback, false, false);
      return {
        reply: fallback,
        expectingPhoto: false,
        onboardingComplete: false,
        verificationRequired: false,
        acceptedOnboardingFields: [],
        contextPromptRequested: false,
        contextDumpStarted: true,
        contextDumpSaved: false,
      };
    }
    contextDumpSaved = true;
    snapshot = await markOnboardingField(telegramId, "context_dump");
  } else {
    snapshot = await collectOnboardingInput(telegramId, input, {
      ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
      ...(deps.extractOnboardingFacts
        ? { extractFacts: deps.extractOnboardingFacts }
        : {}),
    });
    if (
      input.kind === "photos_updated" &&
      snapshot.completedFields.includes("photos")
    ) {
      snapshot = await markOnboardingField(telegramId, "photos");
    }
  }

  // The user asked a clarifying question instead of answering. Nothing was
  // recorded and the question did not advance — answer briefly (short LLM),
  // then re-pose the exact same canonical question.
  if (input.kind === "user_text" && snapshot.needsClarification) {
    const question = onboardingQuestionText(
      snapshot.language,
      snapshot.currentQuestion,
      snapshot.completedFields,
    );
    const clarification = await generateClarificationReply(
      snapshot.language,
      snapshot.currentQuestion,
      input.text,
      deps,
      snapshot.completedFields,
    );
    const reply = clarification ? `${clarification}\n\n${question}` : question;
    await appendCollectorHistory(telegramId, input, reply, false, false);
    return {
      reply,
      expectingPhoto: snapshot.currentQuestion === "photos",
      onboardingComplete: false,
      verificationRequired: false,
      acceptedOnboardingFields: [],
      contextPromptRequested: false,
      contextDumpStarted: false,
      contextDumpSaved: false,
    };
  }

  let expectingPhoto = snapshot.currentQuestion === "photos";
  let onboardingComplete = false;
  let verificationRequired = false;
  let contextPromptRequested = snapshot.currentQuestion === "context_dump";
  let contextDumpStarted = contextPromptRequested;
  let reply = onboardingQuestionText(
    snapshot.language,
    snapshot.currentQuestion,
    snapshot.completedFields,
  );
  const validation = onboardingValidationText(
    snapshot.language,
    snapshot.rejectedFields,
  );
  if (validation) {
    reply = validation;
  } else if (input.kind === "user_text" && snapshot.unparsedAnswer) {
    // The answer produced no fact and the question did not advance: explain
    // what kind of answer works instead of silently re-asking verbatim.
    const notUnderstood = onboardingNotUnderstoodText(
      snapshot.language,
      snapshot.currentQuestion,
      snapshot.completedFields,
    );
    if (notUnderstood) reply = `${notUnderstood}\n\n${reply}`;
  }

  if (snapshot.currentQuestion === "complete") {
    const finalized = await execFinalizeOnboarding(
      telegramId,
      snapshot.completedFields.includes("context_dump"),
      deps,
    );
    const parsed = parseJsonObject(finalized);
    if (parsed?.success === true) {
      onboardingComplete = true;
      verificationRequired = parsed.verificationRequired === true;
      expectingPhoto = false;
      contextPromptRequested = false;
      contextDumpStarted = false;
      reply = onboardingQuestionText(
        snapshot.language,
        "complete",
        snapshot.completedFields,
      );
    } else {
      reply =
        typeof parsed?.error === "string"
          ? parsed.error
          : "I couldn't finish onboarding yet. Please try again.";
    }
  }

  await appendCollectorHistory(
    telegramId,
    input,
    reply,
    contextPromptRequested,
    onboardingComplete,
  );

  return {
    reply,
    expectingPhoto,
    onboardingComplete,
    verificationRequired,
    acceptedOnboardingFields: snapshot.acceptedFields,
    contextPromptRequested,
    contextDumpStarted,
    contextDumpSaved,
  };
}

// ---------------------------------------------------------------------------
// System Prompt
// ---------------------------------------------------------------------------

/**
 * Build the system prompt. When `emailAlreadyVerified` is true (mobile-first
 * users, dev bypass via `DEV_OTP_BYPASS_TELEGRAM_IDS`, or any other path
 * that pre-populates `User.isEmailVerified`), the email-verification rule is
 * dropped from the static prompt entirely. Leaving it in caused the agent to
 * drift back to "MUST provide corporate email" mid-conversation even after a
 * separate `verifiedNote` told it to skip step 1, because the strict-rules
 * line carried much more weight than the trailing override.
 */
function buildSystemPrompt(
  emailAlreadyVerified: boolean,
  aiMemoryExportDeclined: boolean,
): string {
  const emailRule = emailAlreadyVerified
    ? "- Email verification has ALREADY been completed for this user before this conversation began. DO NOT ask the user for their email under ANY circumstances. DO NOT mention email verification. Skip step 1 of the Onboarding Flow entirely. Move directly to step 2 (profile basics)."
    : `- The user MUST provide a corporate university email (domains: ${ALLOWED_EMAIL_DOMAINS.join(", ")}). Do NOT skip email verification.`;

  const aiMemoryRule = aiMemoryExportDeclined
    ? "- The user explicitly declined AI memory export. Do NOT call request_context_dump or save_context_dump, and do NOT ask them to paste anything from another AI app. After profile fields are collected, move directly to request_photos. Context dump is NOT required for this user."
    : "- The user accepted AI memory export. The Magic Prompt context dump is required before photo upload and finalization.";

  return `You are the onboarding assistant for Gennety Dating — an AI-first matchmaking service for university students.

Your mission: guide the user through the onboarding process via natural conversation. Extract the required information and use the provided tools to progress through each step.

## Strict Rules
${emailRule}
${aiMemoryRule}
- Age MUST be between ${MIN_AGE} and ${MAX_AGE}. If the user gives an age outside this range, explain the restriction kindly.
- NEVER create an in-app chat between users. This is a "Zero-Chat" philosophy app — we match people and schedule their first date, no messaging.
- NEVER skip or shortcut any of the required information fields.

## CRITICAL: Honour Information Already Volunteered

Before asking ANY question, scan the user's MOST RECENT message AND the full conversation history for fields they have already given you. Users routinely dump several things in one message — e.g. "Alex, 22, looking for a girl, 180cm, into running and jazz, looking for someone calm and curious".

When this happens:
1. Extract every field that is clear and concrete (name, age, gender, preference, ethnicity/nationality, height, hobbies, partner preferences) and treat them as collected.
2. NEVER re-ask a question whose answer is already visible in the chat history. If the user says "I already told you" or "we covered this", that means YOU made the mistake — briefly apologise, confirm what you have, and only ask for what is genuinely still missing.
3. In your reply, confirm in ONE short bubble what you extracted ("got it: Alex, 22, into running and jazz — looking for a girl"), then ask only for the missing pieces. Combining 1–2 missing fields in a single question is fine.
4. Only ask for a field when you genuinely don't have a concrete value for it. Re-asking already-answered questions is the most common reason users abandon onboarding — do not do it.

This rule overrides the apparent linearity of the flow below: you may skip ahead and harvest in any order, as long as every required field is collected before finalize_onboarding.

### Concrete worked example (the "Ruslan" case)

User's first reply after you ask for name + age:
> Меня зовут Руслан, мне 21 год. Я ищу красивую, аккуратную и женственную
> девушку. О себе: 1) Давно увлекаюсь конным спортом. 2) Учусь за границей,
> но на лето приезжаю сюда. 3) Мой рост — 180 см.

What you MUST extract from this single message:
- first_name: Руслан
- age: 21
- gender: missing — a name is not evidence of gender. Ask the user directly.
- preference: women — "ищу … девушку"
- partner_preferences: "красивая, аккуратная, женственная"
- hobbies: ["конный спорт"]
- height: 180

What you MUST do next: ONE short bubble acknowledging what you got, then ask only for what is genuinely missing (gender, then ethnicity/nationality if needed). Do NOT issue a sequence of questions for values already present. Repeating known questions is the #1 reason users abandon onboarding.

### FORBIDDEN follow-ups (these are bugs, not features)

- NEVER infer gender from a first name. Gender is accepted only from the user's direct answer.
- If the user's gender answer is contradictory or joking (e.g. "I'm a guy and a girl at the same time"), do NOT guess. Ask one short clarification because the matching engine currently needs one of two profile values.
- After "ищу девушку" / "ищу парня" / "ищу обоих" / "looking for a girl/guy/both" → DO NOT ask "кто тебе нравится?" again. Save the preference.
- After ANY first hobby reply (one hobby, several, or "no hobbies") → DO NOT ask for another hobby. The first reply IS the answer.
- After a height like "180 см" / "5'10\"" / "180" appears in any user message → DO NOT re-ask height.
- After a partner-preferences sentence is given → DO NOT ask the user to elaborate or "tell me more".
- After save_context_dump succeeds → move straight to request_photos. DO NOT re-ask any profile field.

If you catch yourself drafting one of these forbidden questions, STOP, re-read the conversation history, and ask only for fields that are GENUINELY absent.

## Onboarding Flow
You MUST collect ALL of the following before finalizing:

1. **Email verification**: Ask for university email → call send_otp_email → ask for OTP code → call verify_otp. If the user says the code didn't arrive, call resend_otp to re-send it (no need to ask for the email again).
2. **Profile basics**: First name, age, gender, gender preference (who they are interested in — men, women, or both). ALWAYS ask these questions in the user's chosen language using native words ONLY — never use English terms like "male/female" or "men/women/both" in your message to the user. Map their natural-language answer internally to the tool enum values.
3. **Extended profile**: Ethnicity/nationality (optional but encouraged; ask exactly once before the Magic Prompt if it was not already given, and accept skipping), height in cm, hobbies/interests (whatever the user shares — one, several, or "no hobbies" are ALL valid; never push for more), partner preferences (one short sentence is plenty)
4. **Deep context extraction**: ${aiMemoryExportDeclined ? "SKIP this entire step because the user declined AI memory export. Never mention or request the Magic Prompt." : "After collecting extended profile, call request_context_dump. The system will AUTOMATICALLY send the Magic Prompt to the user in a separate copyable block — you do NOT need to include or display the prompt yourself."}

   STRICT BOUNDARIES for the reply that accompanies request_context_dump:
   - Your ONLY job in that turn is the paste-it-back instruction. Tell the user to copy the prompt above and paste it into whatever AI chat they already use — ChatGPT, Claude, Gemini, Perplexity, Grok, DeepSeek, or any other LLM — and send the AI's full response back.
   - Do NOT mention photos. Do NOT mention "next step". Do NOT preview anything that comes after this. From the user's point of view, step 5 does not exist yet.
   - Do NOT call request_photos in the same turn as request_context_dump under any circumstances. Wait for the user to actually paste back the analysis and for save_context_dump to succeed first.

   When the user pastes back a long psychological analysis, call save_context_dump with the full text. If the dump is too short or clearly not a real analysis, ask them to try again. Do NOT skip this step.
5. **Photos**: Call request_photos ${aiMemoryExportDeclined ? "after the ordinary profile fields are collected." : "but ONLY after save_context_dump has been called and returned success. Never call request_photos in the same turn as request_context_dump."} The user MUST send at least ${MIN_PHOTOS} photos — this is a hard minimum. Anything beyond ${MIN_PHOTOS} is PURELY OPTIONAL. Once ${MIN_PHOTOS} verified photos have arrived, DO NOT ask for another one. Briefly offer the option ("you can send one more if you want, or we can move on") and default to moving on. Never chain "one more, one more" requests.
6. **Finalize**: Once ALL fields are collected, ${aiMemoryExportDeclined ? "AI memory export is marked declined," : "context dump is saved,"} and at least ${MIN_PHOTOS} photos uploaded, call save_profile_data with all extracted data, then call finalize_onboarding.

## CRITICAL: Answer Validation Rules

NEVER move to the next question or topic until the current one has a CONCRETE, SPECIFIC answer.

### What counts as an INVALID / vague answer (examples):
- "I don't know", "not sure", "hmm", "maybe later", "idk", "whatever"
- "I guess something", "normal", "average", "nothing special"
- Single-word non-answers: "ok", "sure", "yeah", "meh"
- Deflections: "skip this", "does it matter?", "just move on"
- Emojis only without meaningful text

### What to do when the user gives a vague answer:
1. **First attempt**: Acknowledge their hesitation warmly, then rephrase the question with a concrete example. E.g., "No worries! Anything you like doing — sports, music, cooking, gaming? Even one thing works."
2. **Second attempt**: Be more direct — explain WHY this info matters for finding their perfect match. E.g., "This really helps me find someone compatible — even 'I like running' is enough!"
3. **Third attempt**: If they still refuse, accept what you have and move on. For hobbies, "none" / "ничего особенного" is a valid answer — save it as-is and proceed.
4. **After 3 failed attempts for optional fields (ethnicity)**: Accept skipping with a note: "Got it, we'll skip this one."
5. **For REQUIRED fields (name, age, gender, preference, partner preferences)**: NEVER skip. Keep asking until you get a concrete value. You may vary your phrasing, offer examples, or suggest common answers, but do NOT proceed without the data.
6. **For hobbies specifically**: Whatever the user says IS the answer. If they name one hobby, ONE is enough — save it and move on. If they say they have no hobbies, that is also a valid answer — do NOT push back, do NOT ask for "at least one more". Never ask a follow-up hobby question after their first reply.

### Required data quality standards:
- **First name**: An actual name (not "lol", "test", "x")
- **Age**: A number between ${MIN_AGE} and ${MAX_AGE}
- **Gender**: A clear, direct answer identifying the user as a man or a woman (in their own language). NEVER infer it from their name. Internally map the direct answer to the tool enum.
- **Preference**: A clear answer about who they want to date — men, women, or both (in their own language). Internally map to the tool enum.
- **Hobbies**: Whatever the user shares. One hobby is enough. "No hobbies" / "ничего особенного" is a valid answer — save it and move on. NEVER ask for additional hobbies after the first reply.
- **Ethnicity/nationality**: Ask once in a casual optional way before request_context_dump unless the user already volunteered it. If they skip, ignore it, or say they prefer not to answer, proceed with ethnicity unset. NEVER fabricate placeholders like "не указано", "not specified", "unknown", or "n/a".
- **Partner preferences**: One short concrete sentence about what they want (not "anyone" or "idk"). One sentence is plenty — don't ask for more detail once you have one.
- **Height**: A plausible number in cm (140-220) — if the user is unsure of cm, help convert from feet/inches

### Tracking what you've collected:
Before calling save_profile_data, mentally verify you have ALL of these with concrete values:
- Email verified, First name, Age, Gender, Preference, Ethnicity/nationality asked once or already volunteered/skipped, Height, Hobbies (whatever the user gave — even an empty list is fine), Partner preferences (one sentence), ${aiMemoryExportDeclined ? "AI memory export declined (no context dump needed)" : "Context dump saved (via save_context_dump)"}, Photos (${MIN_PHOTOS}+)

If ANY required field is missing or vague, go back and collect it before saving.

## Conversation Style (see VOICE.md — source of truth)
- You are the user's personal AI matchmaker: young, vibey, but a professional with quiet self-respect. A half-friend who is visibly good at his job. Short sentences. Easy to scan.
- BREVITY IS THE DEFAULT: 1–2 short sentences per message; hard cap 3 unless the user asks for detail. If your draft reads like a paragraph, cut it in half.
- Formatting: emphasis is rarely needed; when it is, use SINGLE *asterisks*. NEVER double **asterisks** or __underscores__ — they render as literal symbols in the chat.
- **Never try to sound cool — you already are in the know. When in doubt, say it plainer.** Overdone slang reads as try-hard: one casual word per message max, usually zero. Understatement over hype.
- No formal phrases: no "Здравствуйте", no "Пожалуйста", no corporate speak. Use an informal, native register in Russian/Ukrainian/German/Polish. Chat-style lowercase sentence openings are fine in short replies; keep names and product terms capitalized.
- Emojis are OPTIONAL. Default is ZERO. When you do use one, ≤1 per message and only if it adds something the words don't.
- DO NOT slap ✅ on every confirmation. Repeating the same ✅ on every reply is the #1 user-reported annoyance — it reads like a robotic "Complete" stamp. Default to no emoji on routine acknowledgements; use ✨ when a confirmation genuinely lands. Never use ✅ or 🔥. Never start a message with an emoji.
- Light native seasoning is welcome when natural: вайб/метч in Russian or Ukrainian, casual "Match/Date" phrasing in German, "spoko"-tier Polish. Banned in every language: краш/слэй/база/сигма, rizz/slay/no cap, and equivalents — that dictionary is the try-hard failure mode.
- One idea per message. Don't stack 3 questions in one bubble.
- Lead with the action, not the explanation. Tell the user what to do first, then why (if needed).
- Start with the Zero-Chat pitch: Gennety finds your match, proposes it, schedules the date — no swiping, no chatting. You just show up.
- Then move into email verification.
- You can combine related questions (e.g., "What's your name and how old are you?") but get clear answers before moving on.
- Match the user's language. If they switch, you switch.
- NEVER inject English words into non-English messages during onboarding. Specifically, when asking about gender or dating preference in any non-English language, do NOT write "male", "female", "men", "women", "both", or mixed phrases like "ты male?" / "Male, female, or both?". Ask naturally in the user's language (e.g. Russian: "Ты парень или девушка?", "Кто тебе нравится — парни, девушки или все?"; Ukrainian: "Ти хлопець чи дівчина?", "Хто тобі подобається — хлопці, дівчата чи всі?"; German: "Bist du ein Mann oder eine Frau?", "Auf wen stehst du — Männer, Frauen oder beides?"; Polish: "Jesteś mężczyzną czy kobietą?", "Kto Ci się podoba — mężczyźni, kobiety czy obie opcje?"). Map the user's natural-language reply to the tool enum values internally — the enums (\`male\`/\`female\`, \`men\`/\`women\`/\`both\`) live only inside tool calls, never in chat messages.
- If the user goes off-topic, gently nudge them back — don't lecture.
- If a photo is rejected (no clear face), explain briefly and ask for another.
- NEVER use robotic transitions like "Отлично! Переходим к следующему шагу." or fake enthusiasm: "Невероятно!", "Потрясающе!"

## Handling Questions While Awaiting the Pasted AI Analysis

Once you have called \`request_context_dump\`, the Magic Prompt is visible in the chat above the user. They will sometimes reply with a short clarifying question or comment instead of immediately pasting the AI's response — e.g. "why do I need to do this?", "is this safe?", "what's this analysis for?", "can you explain?".

When that happens:
- Answer warmly and briefly in the user's language. One short paragraph is enough.
- Do NOT call \`request_context_dump\` again — the prompt is already shown above your previous message and re-issuing it just clutters the chat.
- Do NOT call any other tools in this turn. Just reply.
- End by inviting them to paste the AI's response when they're ready.

Reference framing (adapt freely to the user's language and tone): it's a quick read on their psychological profile that helps you match them with someone genuinely compatible. We do the same for everyone, so when they meet their match the obvious red flags are already filtered out. Once they've pasted what their AI returned, you'll move on to photos.

## Important
- Do NOT hallucinate or assume values. If the answer is ambiguous, ASK AGAIN — never guess.
- Call tools when appropriate — don't just talk about doing things.
- After finalize_onboarding, tell the user they're in and that you'll reach out when there's a match. Keep it brief.`;
}

// ---------------------------------------------------------------------------
// Tool Definitions (OpenAI function calling schema)
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "send_otp_email",
      description:
        "Validate the user's corporate university email and send an OTP verification code. Call this when the user provides their email.",
      parameters: {
        type: "object",
        properties: {
          email: {
            type: "string",
            description: "The user's university email address",
          },
        },
        required: ["email"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "verify_otp",
      description:
        "Verify the OTP code the user received via email. Call this when the user provides a 6-digit code.",
      parameters: {
        type: "object",
        properties: {
          code: {
            type: "string",
            description: "The 6-digit OTP code",
          },
        },
        required: ["code"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "resend_otp",
      description:
        "Re-send the OTP verification code to the user's previously provided email. Call this when the user says they didn't receive the code. No parameters needed — uses the email already on file.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "request_context_dump",
      description:
        "Present the Magic Prompt for deep context extraction. Call this AFTER collecting all extended profile data (hobbies, preferences, height) and BEFORE requesting photos. Returns the prompt text — you MUST display it inside a markdown code block so the user can copy it.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "save_context_dump",
      description:
        "Persist the long psychological analysis the user just pasted from their ChatGPT/Claude/etc. Call this when the user's MOST RECENT message looks like a real LLM-generated profile — sections like values, attachment style, communication style, ideal partner, dealbreakers, summary. The server reads the dump from the user's actual message; raw_dump is a hint only and may be omitted or summarized. Do NOT call this if the user's last message is a question, a one-liner, or anything other than a substantial pasted analysis.",
      parameters: {
        type: "object",
        properties: {
          raw_dump: {
            type: "string",
            description:
              "Optional hint — first ~200 chars of the dump or empty. The server uses the user's actual latest message verbatim, so don't bother re-typing the whole thing here.",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "request_photos",
      description: `Open photo upload. Ask the user for at least ${MIN_PHOTOS} photos (hard minimum). Anything beyond ${MIN_PHOTOS} is optional — do NOT pressure for more. Call this when you're ready to collect photos — AFTER context dump has been saved.`,
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "save_profile_data",
      description:
        "Save the user's extracted profile data to the database. Call this once you've collected all required fields.",
      parameters: {
        type: "object",
        properties: {
          first_name: { type: "string", description: "User's first name" },
          age: { type: "integer", description: `User's age (${MIN_AGE}-${MAX_AGE})` },
          gender: {
            type: "string",
            enum: ["male", "female"],
            description: "User's gender",
          },
          preference: {
            type: "string",
            enum: ["men", "women", "both"],
            description: "Who the user is interested in dating",
          },
          ethnicity: {
            type: "string",
            description: "User's ethnicity (optional)",
          },
          height: {
            type: "integer",
            description: "User's height in centimeters",
          },
          hobbies: {
            type: "array",
            items: { type: "string" },
            description: "User's hobbies and interests. Whatever the user said, verbatim — one item, several, or an empty array if they said they have none. Do NOT invent or pad.",
          },
          partner_preferences: {
            type: "string",
            description:
              "Free-text description of what the user is looking for in a partner",
          },
        },
        required: ["first_name", "age", "gender", "preference", "height", "partner_preferences"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "finalize_onboarding",
      description:
        "Mark the onboarding as complete. Call this ONLY after save_profile_data has succeeded and photos have been uploaded.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
];

const CONTEXT_DUMP_SAVED_MARKER = "[CONTEXT_DUMP_SAVED]";
const CURRENT_ONBOARDING_STATE_MARKER = "[CURRENT_SAVED_ONBOARDING_STATE]";

interface PersistedOnboardingState {
  firstName?: string | null;
  age?: number | null;
  gender?: string | null;
  preference?: string | null;
  email?: string | null;
  universityDomain?: string | null;
  isEmailVerified?: boolean | null;
  phoneVerifiedAt?: Date | null;
  aiMemoryExportPreference?: "undecided" | "accepted" | "declined" | null;
  profile?: {
    ethnicity?: string | null;
    height?: number | null;
    hobbies?: string[] | null;
    partnerPreferences?: string | null;
    photos?: string[] | null;
    homeCityKey?: string | null;
  } | null;
}

function parseJsonObject(content: string | null): Record<string, unknown> | null {
  if (!content) return null;
  try {
    const parsed = JSON.parse(content) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function toolResultSucceeded(content: string | null): boolean {
  return parseJsonObject(content)?.success === true;
}

function hasSuccessfulToolResult(
  history: ChatMessage[],
  toolName: string,
): boolean {
  const toolNamesById = new Map<string, string>();

  for (const message of history) {
    if (message.role !== "assistant") continue;
    for (const call of message.tool_calls ?? []) {
      toolNamesById.set(call.id, call.function.name);
    }
  }

  return history.some((message) => {
    if (message.role !== "tool" || !message.tool_call_id) return false;
    return (
      toolNamesById.get(message.tool_call_id) === toolName &&
      toolResultSucceeded(message.content)
    );
  });
}

function conversationSummarySaysContextDumpSaved(content: string): boolean {
  if (!content.includes("[Conversation Summary]")) return false;
  const lower = content.toLowerCase();
  const mentionsContext =
    lower.includes("save_context_dump") ||
    lower.includes("context dump") ||
    lower.includes("ai analysis") ||
    lower.includes("psychological analysis");
  const mentionsSuccess =
    lower.includes("saved") ||
    lower.includes("success") ||
    lower.includes("analysed") ||
    lower.includes("analyzed");
  const mentionsMissing =
    lower.includes("not saved") ||
    lower.includes("has not") ||
    lower.includes("missing") ||
    lower.includes("still needs");

  return mentionsContext && mentionsSuccess && !mentionsMissing;
}

function hasContextDumpSaved(history: ChatMessage[]): boolean {
  if (
    history.some(
      (message) =>
        message.role === "system" &&
        typeof message.content === "string" &&
        (message.content.includes(CONTEXT_DUMP_SAVED_MARKER) ||
          conversationSummarySaysContextDumpSaved(message.content)),
    )
  ) {
    return true;
  }

  return hasSuccessfulToolResult(history, "save_context_dump");
}

function contextDumpSavedSystemMessage(): ChatMessage {
  return {
    role: "system",
    content:
      `${CONTEXT_DUMP_SAVED_MARKER}: The user pasted the Magic Prompt / AI analysis, ` +
      "save_context_dump succeeded, and the deep context is persisted. Do not ask for it again.",
  };
}

function normalizeForRepeatDetection(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function dedupeRepeatedAssistantText(content: string | null | undefined): string | null {
  if (typeof content !== "string" || !content.trim()) return content ?? null;

  const trimmed = content.trimEnd();
  const lineParts = trimmed.split(/\n{1,2}/);
  if (lineParts.length % 2 === 0) {
    const midpoint = lineParts.length / 2;
    const first = lineParts.slice(0, midpoint).join("\n");
    const second = lineParts.slice(midpoint).join("\n");
    if (normalizeForRepeatDetection(first) === normalizeForRepeatDetection(second)) {
      return first.trimEnd();
    }
  }

  const half = Math.floor(trimmed.length / 2);
  const firstHalf = trimmed.slice(0, half);
  const secondHalf = trimmed.slice(half);
  if (
    trimmed.length > 24 &&
    normalizeForRepeatDetection(firstHalf) === normalizeForRepeatDetection(secondHalf)
  ) {
    return firstHalf.trimEnd();
  }

  return content;
}

function status(value: unknown): "saved" | "missing" {
  if (typeof value === "string") return value.trim() ? "saved" : "missing";
  if (typeof value === "number") return Number.isFinite(value) ? "saved" : "missing";
  if (typeof value === "boolean") return value ? "saved" : "missing";
  if (Array.isArray(value)) return value.length > 0 ? "saved" : "missing";
  return value ? "saved" : "missing";
}

function buildCurrentSavedStateSnapshot(
  user: PersistedOnboardingState | null | undefined,
  contextDumpSaved: boolean,
): ChatMessage {
  const profile = user?.profile ?? null;
  const hobbies = Array.isArray(profile?.hobbies) ? profile.hobbies : [];
  const photos = Array.isArray(profile?.photos) ? profile.photos : [];
  // Registration v2: a verified phone (Telegram one-tap, general track)
  // satisfies the contact gate in place of the university email.
  const contactVerified = Boolean(
    (user?.isEmailVerified && user?.email) || user?.phoneVerifiedAt,
  );
  const aiMemoryExportDeclined = user?.aiMemoryExportPreference === "declined";

  const missing: string[] = [];
  if (!contactVerified) missing.push("email_verification");
  if (!user?.firstName) missing.push("first_name");
  if (!user?.age) missing.push("age");
  if (!user?.gender) missing.push("gender");
  if (!user?.preference) missing.push("preference");
  if (!profile?.height) missing.push("height");
  if (!profile?.partnerPreferences) missing.push("partner_preferences");
  if (!profile?.homeCityKey) missing.push("home_city");
  if (!contextDumpSaved && !aiMemoryExportDeclined) missing.push("context_dump");
  if (photos.length < MIN_PHOTOS) missing.push(`photos_${photos.length}/${MIN_PHOTOS}`);

  const lines = [
    CURRENT_ONBOARDING_STATE_MARKER,
    "Use this database snapshot as the source of truth over chat memory.",
    "Never re-ask a field marked saved here. If a saved field is not visible in the chat, still treat it as collected.",
    `Email: ${
      user?.isEmailVerified && user?.email
        ? `verified:${user?.universityDomain ?? "domain_saved"}`
        : user?.phoneVerifiedAt
          ? "not_needed:phone_verified"
          : "missing"
    }`,
    `Profile basics: first_name=${status(user?.firstName)}, age=${user?.age ?? "missing"}, gender=${user?.gender ?? "missing"}, preference=${user?.preference ?? "missing"}`,
    `Extended profile: height=${profile?.height ?? "missing"}, ethnicity=${status(profile?.ethnicity)}, hobbies_count=${hobbies.length}, partner_preferences=${status(profile?.partnerPreferences)}`,
    `Dating city: ${profile?.homeCityKey ? `saved:${profile.homeCityKey}` : "missing"}`,
    `AI memory export: ${user?.aiMemoryExportPreference ?? "undecided"}`,
    `Context dump: ${contextDumpSaved ? "saved" : aiMemoryExportDeclined ? "skipped_by_user" : "missing"}`,
    `Photos: ${photos.length}/${MIN_PHOTOS} required minimum`,
    `Missing next: ${missing.length ? missing.join(", ") : "none"}`,
    aiMemoryExportDeclined
      ? "The user declined AI memory export. Never call request_context_dump or save_context_dump; proceed directly to photos once profile fields are complete."
      : "Ethnicity is optional, but if it is missing you must ask it once before request_context_dump unless the chat already shows you asked or the user skipped it.",
    aiMemoryExportDeclined
      ? "If Photos are missing, call request_photos. Finalize after profile and photos are complete."
      : "If Missing next is context_dump, call request_context_dump now instead of asking profile questions.",
    aiMemoryExportDeclined
      ? "A fallback psychological summary and embedding will be generated server-side during finalization."
      : "If Context dump is saved and Photos are missing, call request_photos. Finalize only after profile, context dump, and photos are complete.",
  ];

  return { role: "system", content: lines.join("\n") };
}

function withCurrentSavedStateSnapshot(
  messages: ChatMessage[],
  user: PersistedOnboardingState | null | undefined,
  fullHistory: ChatMessage[],
): ChatMessage[] {
  const cleaned = messages.filter(
    (message) =>
      !(
        message.role === "system" &&
        typeof message.content === "string" &&
        message.content.startsWith(CURRENT_ONBOARDING_STATE_MARKER)
      ),
  );
  const snapshot = buildCurrentSavedStateSnapshot(user, hasContextDumpSaved(fullHistory));
  let insertAt = 0;
  while (insertAt < cleaned.length && cleaned[insertAt]?.role === "system") {
    insertAt++;
  }
  return [...cleaned.slice(0, insertAt), snapshot, ...cleaned.slice(insertAt)];
}

// ---------------------------------------------------------------------------
// Tool Executors
// ---------------------------------------------------------------------------

async function execSendOtpEmail(
  telegramId: bigint,
  args: { email: string },
  deps: AgentDeps,
): Promise<string> {
  const email = args.email.trim().toLowerCase();

  if (!isUniversityEmail(email)) {
    return JSON.stringify({
      success: false,
      error: `Invalid email. Must be a corporate university email (${ALLOWED_EMAIL_DOMAINS.join(", ")}).`,
    });
  }

  const domain = email.slice(email.indexOf("@") + 1);

  await prisma.user.update({
    where: { telegramId },
    data: {
      email,
      universityDomain: domain,
      emailOtp: null,
      emailOtpExpiresAt: null,
    },
  });

  try {
    await createAndSendOtp(email, deps.sendOtp);
  } catch (err) {
    console.error(`Failed to send OTP email to ${email}`, err);
    return JSON.stringify({
      success: false,
      error: `Failed to send email to ${email}. Please try again in a moment.`,
    });
  }

  return JSON.stringify({
    success: true,
    message: `OTP sent to ${email}. Code expires in 10 minutes.`,
  });
}

async function execResendOtp(
  telegramId: bigint,
  deps: AgentDeps,
): Promise<string> {
  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: { email: true },
  });

  if (!user?.email) {
    return JSON.stringify({
      success: false,
      error: "No email on file. Ask the user for their email first.",
    });
  }

  try {
    await prisma.user.update({
      where: { telegramId },
      data: { emailOtp: null, emailOtpExpiresAt: null },
    });
    await createAndSendOtp(user.email, deps.sendOtp);
  } catch (err) {
    console.error(`Failed to resend OTP email to ${user.email}`, err);
    return JSON.stringify({
      success: false,
      error: `Failed to resend email to ${user.email}. Please try again in a moment.`,
    });
  }

  return JSON.stringify({
    success: true,
    message: `New OTP sent to ${user.email}. Code expires in 10 minutes.`,
  });
}

async function execVerifyOtp(
  telegramId: bigint,
  args: { code: string },
): Promise<string> {
  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: { email: true },
  });

  if (!user?.email) {
    return JSON.stringify({
      success: false,
      error: "No pending OTP. Please provide your email first.",
    });
  }

  const result = await verifyStoredOtp(user.email, args.code.trim());
  if (!result.ok) {
    if (result.reason === "expired") {
      return JSON.stringify({
        success: false,
        error: "OTP expired. Use the resend_otp tool to send a new code.",
      });
    }
    if (result.reason === "exhausted") {
      return JSON.stringify({
        success: false,
        error: "Too many incorrect attempts. Use the resend_otp tool to request a new code.",
      });
    }
    if (result.reason === "mismatch") {
      return JSON.stringify({ success: false, error: "Incorrect OTP code. Try again." });
    }
    return JSON.stringify({
      success: false,
      error: "No pending OTP. Please provide your email first.",
    });
  }

  const verified = await prisma.user.update({
    where: { telegramId },
    // Registration v2: a verified university email IS the student track.
    data: {
      emailOtp: null,
      emailOtpExpiresAt: null,
      isEmailVerified: true,
      registrationTrack: "student",
    },
    select: { id: true },
  });

  // Registration v2 student loyalty: +2 tickets, exactly once (idempotent
  // ledger claim; no-op while tickets are off). Silent here — the agent's own
  // reply acknowledges the verification; the wallet reflects the bonus.
  if (verified?.id) {
    void grantStudentBonusIfEligible(verified.id).catch((err) => {
      console.warn("[student-bonus] agent grant failed:", (err as Error).message);
    });
  }

  return JSON.stringify({
    success: true,
    message: "Email verified successfully!",
  });
}

async function execSaveContextDump(
  telegramId: bigint,
  _args: { raw_dump?: unknown },
  deps: AgentDeps,
  latestUserMessage: string,
): Promise<string> {
  // Truth source is the user's actual latest message, not the LLM-supplied
  // `raw_dump`. LLMs reliably auto-correct / rephrase long text passed
  // through tool args (single-character drift broke the previous strict
  // grounding check on real pastes). Hallucination is still blocked: if
  // the user hasn't pasted anything substantial, length < 200 rejects.
  const raw = latestUserMessage.trim();
  if (raw.length < 200) {
    return JSON.stringify({
      success: false,
      error:
        "The user's latest message is too short to be a real context dump. Ask them to paste the FULL output from their ChatGPT/Claude — not a summary or paraphrase.",
    });
  }

  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: { id: true, firstName: true, language: true },
  });
  if (!user) {
    return JSON.stringify({ success: false, error: "User not found." });
  }

  const analyse = deps.analyseProfile ?? analyseAndSaveProfile;
  try {
    await analyse(user.id, raw, undefined, {
      firstName: user.firstName ?? "User",
      language: user.language ?? "en",
    });
  } catch (err) {
    console.error("Context dump analysis failed:", err);
    return JSON.stringify({
      success: false,
      error: "Failed to analyse the context dump. The user can try pasting it again.",
    });
  }

  return JSON.stringify({
    success: true,
    message:
      "Context dump analysed and saved. Psychological profile and embedding generated. Proceed to photo upload.",
    next_instruction:
      "Context dump is now saved. Do not ask for profile fields again; call request_photos unless photos are already complete.",
  });
}

/**
 * Scan user-authored messages for a clearly-stated height (cm). Used as a
 * defense-in-depth check inside `execSaveProfileData`: if the user said
 * "180 см" / "175 cm" / "5'10\"" in any prior message but the LLM tried to
 * save without the height field, we'd silently drop a value the user already
 * volunteered. Returning the matched value here lets the guard surface it
 * back to the LLM as guidance.
 *
 * Conservative on purpose: only matches `<number><optional space>см|cm|sm`
 * within the plausible 140–220 range. Things like "iPhone 14" or a year
 * like "2024" don't match.
 */
function extractHeightFromHistory(history: ChatMessage[]): number | null {
  // Note: cannot use \b after the unit because JS regex (without /u) treats
  // Cyrillic letters as non-word, so "см\b" would never match. Use a
  // negative lookahead against any letter (Latin or Cyrillic) instead.
  const re = /(?<!\d)(1[4-9]\d|2[01]\d|220)\s*(?:см|cm|sm)(?![A-Za-zА-Яа-яЁё])/i;
  for (const msg of history) {
    if (msg.role !== "user" || typeof msg.content !== "string") continue;
    const match = msg.content.match(re);
    if (match) return Number(match[1]);
  }
  return null;
}

function hasEthnicityPromptAlreadyHappened(history: ChatMessage[]): boolean {
  const promptRe =
    /(ethnicity|nationality|background|origin|национальн|национальность|этнич|этнос|происхождени|по происхождению|корни|етніч|національн|pochodzen|narodowo|herkunft|ethnisch)/i;
  return history.some(
    (msg) => msg.role === "assistant" && typeof msg.content === "string" && promptRe.test(msg.content),
  );
}

function userTextCorpus(history: ChatMessage[]): string {
  return history
    .filter((message) => message.role === "user" && typeof message.content === "string")
    .map((message) => message.content)
    .join("\n")
    .toLowerCase();
}

function containsWord(corpus: string, value: string): boolean {
  const escaped = value.trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!escaped) return false;
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}([^\\p{L}\\p{N}]|$)`, "u").test(corpus);
}

function hasGenderEvidence(gender: "male" | "female", history: ChatMessage[]): boolean {
  const corpus = userTextCorpus(history);
  const re =
    gender === "male"
      ? /\b(male|man|guy|boy)\b|мужчин|мужик|парень|хлопець|чоловік|mężczyzn|mann/i
      : /\b(female|woman|girl)\b|женщин|девушк|девочка|дівчин|жінк|kobiet|frau/i;
  return re.test(corpus);
}

function hasPreferenceEvidence(preference: "men" | "women" | "both", history: ChatMessage[]): boolean {
  const corpus = userTextCorpus(history);
  if (preference === "both") {
    return (
      /\b(both|men and women|women and men|boys and girls|girls and boys|any gender|all genders)\b/i.test(corpus) ||
      /и мужчин и женщин|и женщин и мужчин|и парн|и девуш|обоих|будь-як|будь як|чоловіків і жінок|жінок і чоловіків/i.test(corpus)
    );
  }
  return preference === "men"
    ? /\b(men|man|guys|boys|male)\b|мужчин|парн|чоловік|хлопц|mężczyzn|männer/i.test(corpus)
    : /\b(women|woman|girls|female)\b|женщин|девуш|дівчат|жінок|kobiet|frauen/i.test(corpus);
}

function isPlaceholderText(value: string | null | undefined): boolean {
  if (!value) return true;
  const normalized = value.trim().toLowerCase().replace(/[.\s_-]+/g, " ");
  return new Set([
    "missing",
    "not specified",
    "not provided",
    "unknown",
    "unspecified",
    "n/a",
    "na",
    "none",
    "null",
    "не указано",
    "не указан",
    "неизвестно",
    "нет данных",
  ]).has(normalized);
}

function hasPartnerPreferenceEvidence(value: string, history: ChatMessage[]): boolean {
  if (isPlaceholderText(value)) return false;
  const corpus = userTextCorpus(history);
  const words = value
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 4);
  return words.some((word) => corpus.includes(word));
}

function shouldBlockContextDumpForEthnicity(
  user: PersistedOnboardingState | null | undefined,
  history: ChatMessage[],
): boolean {
  return !user?.profile?.ethnicity && !hasEthnicityPromptAlreadyHappened(history);
}

function normalizeOptionalEthnicity(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = trimmed.toLowerCase().replace(/[.\s_-]+/g, " ");
  const placeholders = new Set([
    "не указано",
    "не указан",
    "неизвестно",
    "нет данных",
    "n/a",
    "na",
    "not specified",
    "not provided",
    "unknown",
    "unspecified",
    "none",
    "null",
  ]);
  return placeholders.has(normalized) ? null : trimmed;
}

function ungroundedProfileFields(
  args: Parameters<typeof execSaveProfileData>[1],
  user: PersistedOnboardingState | null | undefined,
  history: ChatMessage[],
): string[] {
  const missingEvidence: string[] = [];
  const corpus = userTextCorpus(history);

  if (args.first_name !== undefined && args.first_name.trim() !== user?.firstName) {
    if (!containsWord(corpus, args.first_name)) missingEvidence.push("first_name");
  }
  if (args.age !== undefined && args.age !== user?.age) {
    if (!containsWord(corpus, String(args.age))) missingEvidence.push("age");
  }
  if (args.gender !== undefined && args.gender !== user?.gender) {
    if (!hasGenderEvidence(args.gender, history)) missingEvidence.push("gender");
  }
  if (args.preference !== undefined && args.preference !== user?.preference) {
    if (!hasPreferenceEvidence(args.preference, history)) missingEvidence.push("preference");
  }
  if (args.height !== undefined && args.height !== user?.profile?.height) {
    if (extractHeightFromHistory(history) !== args.height) missingEvidence.push("height");
  }
  if (
    args.partner_preferences !== undefined &&
    args.partner_preferences.trim() !== user?.profile?.partnerPreferences
  ) {
    if (!hasPartnerPreferenceEvidence(args.partner_preferences, history)) {
      missingEvidence.push("partner_preferences");
    }
  }

  return missingEvidence;
}

function missingBeforePhoto(
  user: PersistedOnboardingState | null | undefined,
  contextDumpSaved: boolean,
  history: ChatMessage[],
): string[] {
  const missing: string[] = [];
  const profile = user?.profile ?? null;
  // Registration v2: a verified phone OR a verified university email
  // satisfies the contact gate.
  if (!(user?.phoneVerifiedAt || (user?.isEmailVerified && user.email)))
    missing.push("email_verification");
  if (!user?.firstName) missing.push("first_name");
  if (!user?.age) missing.push("age");
  if (!user?.gender) missing.push("gender");
  if (!user?.preference) missing.push("preference");
  if (!profile?.height) missing.push("height");
  if (!profile?.partnerPreferences || isPlaceholderText(profile.partnerPreferences)) {
    missing.push("partner_preferences");
  }
  if (!profile?.homeCityKey) missing.push("home_city");
  if (!profile?.ethnicity && !hasEthnicityPromptAlreadyHappened(history)) {
    missing.push("ethnicity_question");
  }
  if (user?.aiMemoryExportPreference !== "declined" && !contextDumpSaved) {
    missing.push("context_dump");
  }
  return missing;
}

async function execSaveProfileData(
  telegramId: bigint,
  args: {
    first_name?: string;
    age?: number;
    gender?: "male" | "female";
    preference?: "men" | "women" | "both";
    ethnicity?: string;
    height?: number;
    hobbies?: string[];
    partner_preferences?: string;
  },
  _deps: AgentDeps,
  history: ChatMessage[],
): Promise<string> {
  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: {
      id: true,
      firstName: true,
      age: true,
      gender: true,
      preference: true,
      aiMemoryExportPreference: true,
      profile: {
        select: {
          ethnicity: true,
          height: true,
          hobbies: true,
          partnerPreferences: true,
        },
      },
    },
  });
  if (!user) {
    return JSON.stringify({ success: false, error: "User not found." });
  }

  const firstName = args.first_name?.trim() || user.firstName;
  const age = args.age ?? user.age;
  const gender = args.gender ?? (user.gender as "male" | "female" | null);
  const preference =
    args.preference ?? (user.preference as "men" | "women" | "both" | null);
  const ethnicity =
    args.ethnicity === undefined
      ? normalizeOptionalEthnicity(user.profile?.ethnicity ?? null)
      : normalizeOptionalEthnicity(args.ethnicity);
  const height = args.height ?? user.profile?.height ?? null;
  const hobbies =
    args.hobbies === undefined ? (user.profile?.hobbies ?? []) : args.hobbies;
  const partnerPreferences =
    args.partner_preferences === undefined
      ? (user.profile?.partnerPreferences ?? null)
      : args.partner_preferences;

  if (typeof age !== "number" || age < MIN_AGE || age > MAX_AGE) {
    return JSON.stringify({
      success: false,
      error: `Age must be between ${MIN_AGE} and ${MAX_AGE}.`,
    });
  }

  const ungrounded = ungroundedProfileFields(args, user, history);
  if (ungrounded.length > 0) {
    return JSON.stringify({
      success: false,
      error:
        `Cannot save profile data — these fields are not explicitly supported by the user's messages or existing DB state: ${ungrounded.join(", ")}. ` +
        "Do not infer or fabricate gender, preference, height, or partner preferences from a name or vibe. Ask only for the missing fields in one short question.",
    });
  }

  // Defense-in-depth: the system prompt says to extract every field already
  // volunteered (the "Ruslan" repro). LLMs occasionally still call
  // save_profile_data with `height` missing even after the user explicitly
  // wrote "180 см". Re-scan history; if a height is there, refuse the save
  // and feed the extracted value back so the LLM can retry without re-asking.
  if (!height) {
    const inferred = extractHeightFromHistory(history);
    if (inferred !== null) {
      return JSON.stringify({
        success: false,
        error:
          `Cannot save — the user already volunteered height = ${inferred} cm in a prior message, ` +
          `but it's missing from save_profile_data args. Re-call save_profile_data with height=${inferred} ` +
          `(plus all other fields you already have). Do NOT ask the user for height again.`,
      });
    }
  }

  const missing: string[] = [];
  if (!firstName) missing.push("first_name");
  if (!gender) missing.push("gender");
  if (!preference) missing.push("preference");
  if (!height) missing.push("height");
  const partnerPreferencesText = partnerPreferences?.trim() ?? "";
  if (!partnerPreferencesText) missing.push("partner_preferences");

  if (missing.length > 0) {
    return JSON.stringify({
      success: false,
      error:
        `Cannot save profile data — missing required fields: ${missing.join(", ")}. ` +
        "Use the current DB snapshot and chat history to fill already-saved values; only ask the user for truly missing fields.",
    });
  }

  await prisma.user.update({
    where: { telegramId },
    data: {
      firstName,
      age,
      gender,
      preference,
    },
  });

  await prisma.profile.upsert({
    where: { userId: user.id },
    create: {
      userId: user.id,
      ethnicity,
      height,
      hobbies,
      partnerPreferences: partnerPreferencesText,
    },
    update: {
      ethnicity,
      height,
      hobbies,
      partnerPreferences: partnerPreferencesText,
    },
  });

  return JSON.stringify({
    success: true,
    message: "Profile data saved successfully. Treat these fields as collected.",
    saved: {
      first_name: true,
      age,
      gender,
      preference,
      ethnicity: Boolean(ethnicity),
      height,
      hobbies_count: hobbies.length,
      partner_preferences: true,
    },
    next_instruction:
      user.aiMemoryExportPreference === "declined"
        ? "Do not ask for saved profile fields again. AI memory export was declined, so call request_photos now and never request a context dump."
        : "Do not ask for saved profile fields again. If context_dump is not saved, call request_context_dump now. If context_dump is saved, continue to photos/finalization as appropriate.",
  });
}

async function execFinalizeOnboarding(
  telegramId: bigint,
  contextDumpSaved: boolean,
  deps: AgentDeps,
): Promise<string> {
  // Guard: verify all required profile data exists before finalizing
  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: {
      id: true,
      firstName: true,
      age: true,
      gender: true,
      preference: true,
      email: true,
      isEmailVerified: true,
      phoneVerifiedAt: true,
      language: true,
      aiMemoryExportPreference: true,
      profile: {
        select: {
          ethnicity: true,
          height: true,
          hobbies: true,
          partnerPreferences: true,
          fridayVibeText: true,
          vibeFocusText: true,
          photos: true,
          homeCityKey: true,
        },
      },
    },
  });

  const missing: string[] = [];
  if (!user?.firstName) missing.push("first_name");
  if (!user?.age) missing.push("age");
  if (!user?.gender) missing.push("gender");
  if (!user?.preference) missing.push("preference");
  // Registration v2: a verified phone OR a verified university email
  // satisfies the contact gate.
  if (!(user?.phoneVerifiedAt || (user?.isEmailVerified && user.email)))
    missing.push("contact (phone/email not verified)");
  if (!user?.profile?.height) missing.push("height");
  // Hobbies are no longer a blocking requirement: whatever the user shared
  // (including "no hobbies" / an empty list) is a valid answer.
  if (!user?.profile?.partnerPreferences)
    missing.push("partner_preferences");
  if (!user?.profile?.homeCityKey)
    missing.push("home_city");
  const aiMemoryExportDeclined = user?.aiMemoryExportPreference === "declined";
  if (!contextDumpSaved && !aiMemoryExportDeclined)
    missing.push("context_dump (deep profile not yet saved)");
  if (!user?.profile?.photos?.length || user.profile.photos.length < MIN_PHOTOS)
    missing.push(`photos (need at least ${MIN_PHOTOS})`);

  if (missing.length > 0) {
    return JSON.stringify({
      success: false,
      error: `Cannot finalize — missing required data: ${missing.join(", ")}. Please collect these before calling finalize_onboarding.`,
    });
  }

  // Vibe signal (PRODUCT_SPEC §1.3 / §3.2). Map the two free-text answers into
  // structured axes for the matching engine. Best-effort: a failure here never
  // blocks finalize — the engine simply skips the quadrant factor when axes are
  // null. Runs for accepted AND declined users.
  const fridayVibe = user?.profile?.fridayVibeText ?? null;
  const vibeFocus = user?.profile?.vibeFocusText ?? null;
  if (user) {
    const extractAxes = deps.extractVibeAxes ?? extractVibeAxes;
    const persistAxes = deps.saveVibeAxes ?? saveVibeAxes;
    try {
      const axes = await extractAxes(
        fridayVibe,
        vibeFocus,
        user.language ?? "en",
        deps.fetchFn ? { fetchFn: deps.fetchFn } : {},
      );
      await persistAxes(user.id, axes);
    } catch (err) {
      console.warn("Vibe-axis extraction failed (non-blocking):", err);
    }
  }

  if (aiMemoryExportDeclined && user?.profile) {
    const saveFallback = deps.saveFallbackProfile ?? saveFallbackProfileAnalysis;
    try {
      await saveFallback(user.id, {
        firstName: user.firstName!,
        age: user.age!,
        gender: user.gender!,
        preference: user.preference!,
        height: user.profile.height!,
        ethnicity: user.profile.ethnicity ?? null,
        hobbies: user.profile.hobbies ?? [],
        partnerPreferences: user.profile.partnerPreferences!,
        homeCityKey: user.profile.homeCityKey!,
        fridayVibe,
        vibeFocus,
      });
    } catch (err) {
      console.error("Fallback profile analysis failed:", err);
      return JSON.stringify({
        success: false,
        error: "Could not build the fallback profile analysis. Please try finalizing again.",
      });
    }
  } else if (user?.profile) {
    // Accepted Magic Prompt: the summary already exists (saved at context-dump
    // time) without the vibe — fold it in and re-mark the embedding dirty so
    // the refresh worker re-embeds with the vibe included. Best-effort.
    const foldVibe = deps.appendVibeToSummary ?? appendVibeToSummary;
    try {
      await foldVibe(user.id, fridayVibe, vibeFocus);
    } catch (err) {
      console.warn("Vibe summary fold failed (non-blocking):", err);
    }
  }

  // Gate activation on Persona liveness verification (Phase 6.3). The
  // master kill switch is `ENABLE_PERSONA_VERIFICATION`; the credential
  // check is a defensive secondary gate so a half-configured deploy
  // (flag on, creds missing) doesn't strand users at a broken CTA.
  // When the gate passes, the user stays in `onboarding` status with
  // `onboardingStep: completed` until either the webhook flips them to
  // `active` (verified) or they tap "Skip" in `handleVerificationSkip`.
  const personaEnabled = env.ENABLE_PERSONA_VERIFICATION
    && Boolean(
      env.PERSONA_TEMPLATE_ID && env.PERSONA_ENVIRONMENT_ID && env.PERSONA_WEBHOOK_SECRET,
    );

  const finalized = await prisma.user.update({
    where: { telegramId },
    data: {
      onboardingStep: "completed",
      ...(personaEnabled ? {} : { status: "active" }),
      ...reEngagementStopPatch,
    },
    select: { id: true, profile: { select: { profilerStartedAt: true } } },
  });

  // Arm the Profiler (PRODUCT_SPEC §Phase 1b): first question fires ~10 min
  // after onboarding completes (the worker defers it out of local quiet
  // hours). Idempotent — skip if already armed (re-finalize / resume).
  if (finalized?.profile && !finalized.profile.profilerStartedAt) {
    const now = new Date();
    await prisma.profile.update({
      where: { userId: finalized.id },
      data: {
        profilerStartedAt: now,
        profilerNextAt: new Date(now.getTime() + PROFILER_ENTRY_DELAY_MS),
      },
    });
  }

  return JSON.stringify({
    success: true,
    message: personaEnabled
      ? "Onboarding data saved. User must complete Persona verification before matching."
      : "Onboarding complete. User is now active.",
    verificationRequired: personaEnabled,
  });
}

// ---------------------------------------------------------------------------
// History Truncation
// ---------------------------------------------------------------------------

/**
 * Truncate conversation history for the LLM API call.
 * Keeps leading system messages + the most recent messages up to `maxMessages`.
 * Avoids splitting assistant→tool sequences by walking back if the cut lands
 * on a tool result message.
 */
export function truncateForApi(
  history: ChatMessage[],
  maxMessages: number = MAX_HISTORY_FOR_API,
): ChatMessage[] {
  if (history.length <= maxMessages) return history;

  // Collect leading system messages (system prompt + any injected summaries)
  let systemEnd = 0;
  while (systemEnd < history.length && history[systemEnd].role === "system") {
    systemEnd++;
  }

  const systemMessages = history.slice(0, systemEnd);
  const rest = history.slice(systemEnd);

  const keepCount = maxMessages - systemMessages.length;
  if (keepCount <= 0) return systemMessages.slice(0, maxMessages);

  let startIdx = rest.length - keepCount;
  if (startIdx < 0) startIdx = 0;

  // Don't split in the middle of a tool-call sequence: if the first kept
  // message is a tool result, walk back to include the preceding assistant msg.
  while (startIdx > 0 && rest[startIdx].role === "tool") {
    startIdx--;
  }

  return [...systemMessages, ...rest.slice(startIdx)];
}

// ---------------------------------------------------------------------------
// History Summarization
// ---------------------------------------------------------------------------

const SUMMARY_SYSTEM_PROMPT = `Summarize the following conversation excerpt concisely.
Focus on: information collected (email, name, age, gender, preferences, photos),
verification steps completed, tool results, and key decisions.
Omit small-talk. Output a single paragraph, max 300 words.`;

/**
 * When the stored history exceeds SUMMARIZE_THRESHOLD, compress the older
 * messages (between leading system messages and the recent window) into a
 * single "[Conversation Summary]" system message. This permanently replaces
 * the old messages in the array so the DB doesn't grow unboundedly.
 *
 * Returns the (possibly shortened) history.
 */
export async function summarizeHistory(
  history: ChatMessage[],
  fetchFn: typeof fetch,
  threshold: number = SUMMARIZE_THRESHOLD,
  keepRecent: number = KEEP_RECENT_MESSAGES,
): Promise<ChatMessage[]> {
  if (history.length <= threshold) return history;

  // Locate the boundary of leading system messages
  let systemEnd = 0;
  while (systemEnd < history.length && history[systemEnd].role === "system") {
    systemEnd++;
  }

  const systemMessages = history.slice(0, systemEnd);
  const cutoff = history.length - keepRecent;

  // Nothing to summarize if the old segment is empty
  if (cutoff <= systemEnd) return history;

  const oldMessages = history.slice(systemEnd, cutoff);
  const recentMessages = history.slice(cutoff);

  // Build a readable transcript of the old messages for the summarizer
  const transcript = oldMessages
    .map((m) => {
      const content = m.content ?? (m.tool_calls ? "[tool_calls]" : "");
      return `${m.role}: ${content}`;
    })
    .join("\n");

  const summaryMessages: ChatMessage[] = [
    { role: "system", content: SUMMARY_SYSTEM_PROMPT },
    { role: "user", content: transcript },
  ];

  const res = await fetchFn("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-5.4-mini",
      messages: summaryMessages,
      temperature: 0.3,
      max_completion_tokens: 512,
    }),
    signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS),
  });

  if (!res.ok) {
    // If summarization fails, fall back to unsummarized history —
    // truncateForApi will still cap it for the API call.
    console.warn("History summarization failed, skipping:", res.status);
    return history;
  }

  const json = (await res.json()) as ChatCompletionResponse;
  const summary = json.choices[0]?.message?.content ?? "";
  const alreadyHasLeadingMarker = systemMessages.some(
    (message) =>
      typeof message.content === "string" &&
      message.content.includes(CONTEXT_DUMP_SAVED_MARKER),
  );
  const contextDumpMarker = hasContextDumpSaved(history) && !alreadyHasLeadingMarker
    ? [contextDumpSavedSystemMessage()]
    : [];

  return [
    ...systemMessages,
    ...contextDumpMarker,
    { role: "system", content: `[Conversation Summary]: ${summary}` },
    ...recentMessages,
  ];
}

// ---------------------------------------------------------------------------
// Core Agent Loop
// ---------------------------------------------------------------------------

/**
 * Run one turn of the conversational onboarding agent.
 *
 * Appends the user's message to the stored conversation history, calls
 * OpenAI chat completions with function-calling tools, executes any
 * tool_calls the model returns, feeds results back, and repeats until the
 * model produces a final text response.
 *
 * Returns the assistant's reply and flags for the bot handler.
 */
export async function runAgentTurn(
  telegramId: bigint,
  input: string | OnboardingInput,
  deps: AgentDeps = {},
): Promise<AgentTurnResult> {
  const onboardingInput = normalizedOnboardingInput(input);
  const userMessage =
    onboardingInput.kind === "user_text" || onboardingInput.kind === "context_dump"
      ? onboardingInput.text
      : onboardingInput.kind === "photos_continue"
        ? "[The user chose Continue after the optional photo/video offer. Finalize onboarding now and do not ask for more media.]"
      : "";
  const fetchFn = deps.fetchFn ?? openaiFetch;

  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: {
      messageHistory: true,
      onboardingStep: true,
      language: true,
      email: true,
      universityDomain: true,
      isEmailVerified: true,
      phoneVerifiedAt: true,
      aiMemoryExportPreference: true,
      firstName: true,
      age: true,
      gender: true,
      preference: true,
      onboardingProgress: {
        select: { completedFields: true },
      },
      profile: {
        select: {
          ethnicity: true,
          height: true,
          hobbies: true,
          partnerPreferences: true,
          photos: true,
          homeCityKey: true,
        },
      },
    },
  });

  if (onboardingInput.kind === "photos_continue") {
    const history = ((user?.messageHistory ?? []) as unknown[]).map(
      (message) => message as ChatMessage,
    );
    const contextDumpSaved =
      user?.aiMemoryExportPreference === "declined" ||
      user?.onboardingProgress?.completedFields.includes("context_dump") ||
      hasContextDumpSaved(history);
    const finalized = await execFinalizeOnboarding(
      telegramId,
      contextDumpSaved,
      deps,
    );
    const parsed = parseJsonObject(finalized);
    const onboardingComplete = parsed?.success === true;
    const verificationRequired = parsed?.verificationRequired === true;
    const reply = onboardingComplete
      ? onboardingQuestionText(
          user?.language ?? "en",
          "complete",
        )
      : typeof parsed?.error === "string"
        ? parsed.error
        : "I couldn't finish onboarding yet. Please try again.";

    await appendCollectorHistory(
      telegramId,
      onboardingInput,
      reply,
      false,
      onboardingComplete,
    );
    return {
      reply,
      expectingPhoto: !onboardingComplete,
      onboardingComplete,
      verificationRequired,
      contextPromptRequested: false,
      contextDumpStarted: false,
      contextDumpSaved: false,
    };
  }

  if (
    env.ONBOARDING_FACT_COLLECTOR_ENABLED &&
    user?.onboardingStep === "conversational" &&
    // Registration v2: a verified phone OR a verified email satisfies the
    // contact gate before the collector takes over.
    (user.phoneVerifiedAt || (user.isEmailVerified && user.email))
  ) {
    return runCollectorTurn(telegramId, onboardingInput, deps);
  }

  // Rebuild messages array from stored history
  const history: ChatMessage[] = (
    (user?.messageHistory ?? []) as unknown[]
  ).map((m) => m as unknown as ChatMessage);

  // Seed system prompt on first turn
  if (history.length === 0) {
    const langNote = user?.language
      ? `The user's preferred language is: ${user.language}. Respond in that language unless they switch.`
      : "";
    // If the user arrives with email already verified (mobile-first flow, or
    // a Telegram restart after the OTP was previously consumed, or dev
    // bypass), build the prompt with the email-verification rule omitted
    // entirely. The agent used to drift back to "MUST provide corporate
    // email" mid-conversation when only a trailing override note told it to
    // skip step 1; now the conflicting rule simply isn't in the prompt.
    const emailVerified = Boolean(user?.isEmailVerified && user?.email);
    // Registration v2: phone (Telegram one-tap, general track) satisfies the
    // contact gate in place of email.
    const phoneVerified = Boolean(user?.phoneVerifiedAt);
    const emailAlreadyVerified = emailVerified || phoneVerified;
    const aiMemoryExportDeclined = user?.aiMemoryExportPreference === "declined";
    const verifiedNote = emailVerified
      ? `[VERIFIED EMAIL ON FILE: ${user!.email}] DO NOT ask the user for their email. DO NOT mention email verification. Skip step 1 of the onboarding flow entirely and move directly to profile basics (step 2). Briefly acknowledge in the user's language (e.g. "your @${user!.universityDomain ?? user!.email!.split("@")[1]} email is already verified"), then ask for first name + age. Do NOT add a ✅ or any "Complete"-style emoji to this acknowledgement.`
      : phoneVerified
        ? `[VERIFIED PHONE ON FILE] The user's phone number is already verified via Telegram. DO NOT ask the user for an email or a phone number, and DO NOT mention email or phone verification. Skip step 1 of the onboarding flow entirely and move directly to profile basics (step 2): ask for first name + age. Do NOT add a ✅ or any "Complete"-style emoji.`
        : "";
    history.push({
      role: "system",
      content: [
        buildSystemPrompt(emailAlreadyVerified, aiMemoryExportDeclined),
        langNote,
        verifiedNote,
      ]
        .filter(Boolean)
        .join("\n\n"),
    });
  }

  // Append user message
  history.push({ role: "user", content: userMessage });

  // Compress old messages when the history grows too large.
  // This permanently replaces old messages with a summary so the DB stays lean.
  const summarized = await summarizeHistory(history, fetchFn);
  // Replace history contents in-place only when summarization actually
  // produced a new array (avoids clearing via same-reference mutation).
  if (summarized !== history) {
    history.length = 0;
    history.push(...summarized);
  }

  let expectingPhoto = false;
  let onboardingComplete = false;
  let verificationRequired = false;
  let contextPromptRequested = false;
  let contextDumpStarted = false;
  let contextDumpSaved = false;
  let profileDataSavedThisTurn = false;

  // Loop: call OpenAI, handle tool_calls, repeat until we get a text reply
  const MAX_TOOL_ROUNDS = 8;
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await callOpenAI(
      withCurrentSavedStateSnapshot(truncateForApi(history), user, history),
      fetchFn,
    );

    const choice = response.choices[0];
    if (!choice) break;

    const assistantMsg = choice.message;
    const assistantContent = dedupeRepeatedAssistantText(assistantMsg.content);
    const rawToolCalls = assistantMsg.tool_calls ?? [];
    const contextDumpToolCall = rawToolCalls.find(
      (call) => call.function.name === "request_context_dump",
    );
    const toolCalls = contextDumpToolCall ? [contextDumpToolCall] : rawToolCalls;
    let stopAfterToolRound = false;

    // Push assistant message to history. If the model bundled request_context_dump
    // with later tools, keep only that boundary call; unexecuted tool calls would
    // make future OpenAI requests invalid and, more importantly, would represent
    // side effects that must wait for the user's pasted dump.
    history.push({
      role: "assistant",
      content: assistantContent,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    });

    // If no tool calls, we have the final reply
    if (toolCalls.length === 0) {
      break;
    }

    // Execute each tool call and append results
    for (const toolCall of toolCalls) {
      const fnName = toolCall.function.name;
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(toolCall.function.arguments);
      } catch {
        args = {};
      }

      let result: string;

      try {
        switch (fnName) {
          case "send_otp_email":
            result = await execSendOtpEmail(
              telegramId,
              args as { email: string },
              deps,
            );
            break;
          case "verify_otp":
            result = await execVerifyOtp(telegramId, args as { code: string });
            break;
          case "resend_otp":
            result = await execResendOtp(telegramId, deps);
            break;
          case "request_context_dump":
            if (user?.aiMemoryExportPreference === "declined") {
              result = JSON.stringify({
                success: false,
                error:
                  "The user declined AI memory export. Do not show the Magic Prompt. " +
                  "Continue with the remaining profile fields, then call request_photos.",
              });
            } else if (shouldBlockContextDumpForEthnicity(user, history)) {
              result = JSON.stringify({
                success: false,
                error:
                  "Before request_context_dump, ask the user ONE short optional ethnicity/nationality question in their language. " +
                  "Example in Russian: \"Как ты описываешь своё происхождение или национальность? Можно пропустить\" " +
                  "Do not ask any other profile question in that message. If they skip, ignore it, or answer another field, you may proceed next time.",
              });
            } else {
              contextPromptRequested = true;
              contextDumpStarted = true;
              result = JSON.stringify({
                success: true,
                message:
                  "Magic Prompt has been sent. The server is stopping this turn and waiting for the user's pasted LLM response.",
              });
              stopAfterToolRound = true;
            }
            break;
          case "save_context_dump":
            if (user?.aiMemoryExportPreference === "declined") {
              result = JSON.stringify({
                success: false,
                error:
                  "The user declined AI memory export. Do not save or request a context dump; continue to photos.",
              });
            } else {
              result = await execSaveContextDump(
                telegramId,
                args as { raw_dump?: unknown },
                deps,
                userMessage,
              );
            }
            break;
          case "request_photos": {
            // Defense-in-depth: the system prompt forbids calling request_photos
            // before save_context_dump succeeds, but LLMs occasionally violate
            // it — chaining request_context_dump → request_photos in the same
            // turn, which leaves the user stranded mid-step. Enforce the
            // ordering server-side by requiring a successful save_context_dump
            // tool result, not just any psychologicalSummary row.
            if (
              user?.aiMemoryExportPreference !== "declined" &&
              !hasContextDumpSaved(history)
            ) {
              result = JSON.stringify({
                success: false,
                error:
                  "Cannot start photo upload yet — the user has not pasted their AI analysis. " +
                  "Wait for them to paste the long psychological analysis from their ChatGPT/Claude/etc., " +
                  "and only call save_context_dump (and then request_photos AFTER it succeeds). " +
                  "If you just called request_context_dump in this same turn, end your reply now with the " +
                  "paste-it-back instruction; do NOT call any more tools until the user replies.",
              });
              break;
            }
            const photoGateUser = profileDataSavedThisTurn
              ? await prisma.user.findUnique({
                  where: { telegramId },
                  select: {
                    firstName: true,
                    age: true,
                    gender: true,
                    preference: true,
                    email: true,
                    isEmailVerified: true,
                    phoneVerifiedAt: true,
                    aiMemoryExportPreference: true,
                    profile: {
                      select: {
                        ethnicity: true,
                        height: true,
                        hobbies: true,
                        partnerPreferences: true,
                        photos: true,
                        homeCityKey: true,
                      },
                    },
                  },
                })
              : user;
            const missingForPhotos = missingBeforePhoto(
              photoGateUser,
              hasContextDumpSaved(history),
              history,
            );
            if (missingForPhotos.length > 0) {
              result = JSON.stringify({
                success: false,
                error:
                  `Cannot start photo upload yet — missing or unconfirmed onboarding fields: ${missingForPhotos.join(", ")}. ` +
                  "Ask only for these fields now. If ethnicity_question is listed, ask one short optional ethnicity/nationality question and allow the user to skip.",
              });
              break;
            }
            expectingPhoto = true;
            result = JSON.stringify({
              success: true,
              message: `Photo upload mode activated. Waiting for ${MIN_PHOTOS}-${MAX_PHOTOS} photos.`,
            });
            break;
          }
          case "save_profile_data":
            result = await execSaveProfileData(
              telegramId,
              args as Parameters<typeof execSaveProfileData>[1],
              deps,
              history,
            );
            if (toolResultSucceeded(result)) profileDataSavedThisTurn = true;
            break;
          case "finalize_onboarding":
            result = await execFinalizeOnboarding(
              telegramId,
              hasContextDumpSaved(history),
              deps,
            );
            {
              const parsed = JSON.parse(result) as {
                success: boolean;
                verificationRequired?: boolean;
              };
              if (parsed.success) {
                onboardingComplete = true;
                verificationRequired = parsed.verificationRequired === true;
              }
            }
            break;
          default:
            result = JSON.stringify({ error: `Unknown tool: ${fnName}` });
        }
      } catch (err) {
        // Surface the error to the LLM as a tool result rather than crashing
        // the whole turn. This lets the agent recover gracefully (e.g. apologize
        // and re-ask the user) instead of dropping them into bot.catch → "Something went wrong".
        console.error(`Tool executor ${fnName} threw:`, err);
        result = JSON.stringify({
          success: false,
          error: `Tool ${fnName} failed with an internal error. Apologize briefly and re-ask the user for the relevant info. Do NOT call this tool again with the same arguments.`,
        });
      }

      history.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: result,
      });

      if (fnName === "save_context_dump" && toolResultSucceeded(result)) {
        contextDumpSaved = true;
        history.push(contextDumpSavedSystemMessage());
      }

      // Persist the Magic Prompt as an assistant turn so non-Telegram clients
      // (mobile chat) can render it. Telegram still sends ctx.reply(prompt)
      // separately; this just records what was already shown.
      if (fnName === "request_context_dump") {
        history.push({
          role: "assistant",
          content: magicContextPrompt(user?.language ?? "en"),
        });
        history.push({
          role: "assistant",
          content: contextDumpInstruction(user?.language),
        });
        break;
      }
    }

    if (stopAfterToolRound) {
      break;
    }
  }

  const now = new Date();
  const reEngagementData = onboardingComplete
    ? {
        lastMessageAt: now,
        ...reEngagementStopPatch,
      }
    : onboardingActivityPatch(now);

  // Persist updated history. Any normal onboarding activity re-arms the
  // reminder chain; successful completion hard-stops it instead.
  await prisma.user.update({
    where: { telegramId },
    data: {
      messageHistory: history as unknown as Prisma.InputJsonValue[],
      ...reEngagementData,
    },
  });

  // Extract final assistant reply
  const lastAssistant = [...history]
    .reverse()
    .find((m) => m.role === "assistant" && m.content);
  const reply = lastAssistant?.content ?? "Something went wrong on my end. Try again in a sec.";

  return {
    reply,
    expectingPhoto,
    onboardingComplete,
    verificationRequired,
    contextPromptRequested,
    contextDumpStarted,
    contextDumpSaved,
  };
}

/**
 * Inject a system-level notification into the conversation history.
 * Used for photo validation results and re-engagement context.
 */
export async function injectSystemMessage(
  telegramId: bigint,
  content: string,
): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: { messageHistory: true },
  });

  const history = (
    (user?.messageHistory ?? []) as unknown[]
  ).map((m) => m as unknown as ChatMessage);

  history.push({ role: "system", content });

  await prisma.user.update({
    where: { telegramId },
    data: {
      messageHistory: history as unknown as Prisma.InputJsonValue[],
      ...onboardingActivityPatch(),
    },
  });
}

// ---------------------------------------------------------------------------
// OpenAI API Call
// ---------------------------------------------------------------------------

/** Milliseconds before we give up on an OpenAI request and throw a timeout error. */
const OPENAI_TIMEOUT_MS = 45_000;

async function callOpenAI(
  messages: ChatMessage[],
  fetchFn: typeof fetch,
): Promise<ChatCompletionResponse> {
  // Retry on transient failures (429 rate limit, 5xx). Exponential backoff.
  const MAX_ATTEMPTS = 3;
  let lastBody = "";
  let lastStatus = 0;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const res = await fetchFn("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-5.4-mini",
        messages,
        tools: TOOLS,
        tool_choice: "auto",
        temperature: 0.4,
        max_completion_tokens: 1024,
      }),
      signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS),
    });

    if (res.ok) {
      return (await res.json()) as ChatCompletionResponse;
    }

    lastStatus = res.status;
    lastBody = await res.text();

    // Retry only on rate limits / server errors, not on 4xx client errors
    const shouldRetry = res.status === 429 || res.status >= 500;
    if (!shouldRetry || attempt === MAX_ATTEMPTS - 1) {
      break;
    }

    // Respect Retry-After header if present, else exponential backoff: 1.5s, 4s
    const retryAfterHeader = res.headers.get("retry-after");
    const retryAfterSec = retryAfterHeader ? parseFloat(retryAfterHeader) : NaN;
    const backoffMs = Number.isFinite(retryAfterSec)
      ? Math.min(retryAfterSec * 1000, 10_000)
      : 1500 * Math.pow(2, attempt);
    console.warn(
      `OpenAI ${res.status}, retrying in ${backoffMs}ms (attempt ${attempt + 1}/${MAX_ATTEMPTS})`,
    );
    await new Promise((r) => setTimeout(r, backoffMs));
  }

  throw new Error(`OpenAI API error: ${lastStatus} ${lastBody}`);
}
