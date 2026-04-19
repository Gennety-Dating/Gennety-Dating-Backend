import { prisma, Prisma } from "@gennety/db";
import {
  isUniversityEmail,
  generateOtp,
  OTP_LENGTH,
  OTP_TTL_MS,
  MIN_PHOTOS,
  MAX_PHOTOS,
  MIN_AGE,
  MAX_AGE,
  ALLOWED_EMAIL_DOMAINS,
  MAX_HISTORY_FOR_API,
  SUMMARIZE_THRESHOLD,
  KEEP_RECENT_MESSAGES,
  MAGIC_CONTEXT_PROMPT,
} from "@gennety/shared";
import { env } from "../config.js";
import { sendOtpEmail } from "./email.js";
import { analyseAndSaveProfile } from "./profile-analysis.js";
import {
  onboardingActivityPatch,
  reEngagementStopPatch,
} from "../workers/re-engagement-schedule.js";

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
  /** When true, the handler must send MAGIC_CONTEXT_PROMPT in a code block after the reply */
  contextPromptRequested: boolean;
  /**
   * When true, the handler must switch the session into context-dump-buffering
   * mode so that subsequent messages are accumulated before being sent to the
   * agent (Telegram splits long pastes into multiple messages).
   */
  contextDumpStarted: boolean;
}

/** Injectable dependencies for testing */
export interface AgentDeps {
  fetchFn?: typeof fetch;
  sendOtp?: (to: string, otp: string) => Promise<void>;
  analyseProfile?: typeof analyseAndSaveProfile;
}

// ---------------------------------------------------------------------------
// System Prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are the onboarding assistant for Gennety Dating — an AI-first matchmaking service for university students.

Your mission: guide the user through the onboarding process via natural conversation. Extract the required information and use the provided tools to progress through each step.

## Strict Rules
- The user MUST provide a corporate university email (domains: ${ALLOWED_EMAIL_DOMAINS.join(", ")}). Do NOT skip email verification.
- Age MUST be between ${MIN_AGE} and ${MAX_AGE}. If the user gives an age outside this range, explain the restriction kindly.
- NEVER create an in-app chat between users. This is a "Zero-Chat" philosophy app — we match people and schedule their first date, no messaging.
- NEVER skip or shortcut any of the required information fields.

## Onboarding Flow
You MUST collect ALL of the following before finalizing:

1. **Email verification**: Ask for university email → call send_otp_email → ask for OTP code → call verify_otp. If the user says the code didn't arrive, call resend_otp to re-send it (no need to ask for the email again).
2. **Profile basics**: First name, age, gender, gender preference (who they are interested in — men, women, or both). ALWAYS ask these questions in the user's chosen language using native words ONLY — never use English terms like "male/female" or "men/women/both" in your message to the user. Map their natural-language answer internally to the tool enum values.
3. **Extended profile**: Ethnicity (optional but encouraged), height in cm, hobbies/interests (whatever the user shares — one, several, or "no hobbies" are ALL valid; never push for more), partner preferences (one short sentence is plenty)
4. **Deep context extraction**: After collecting extended profile, call request_context_dump. The system will AUTOMATICALLY send the Magic Prompt to the user in a separate copyable block — you do NOT need to include or display the prompt yourself. After calling the tool, just write a short message explaining: "Copy the prompt above, paste it into your ChatGPT or Claude, and send me back what it says." When the user pastes back a long psychological analysis, call save_context_dump with the full text. If the dump is too short or clearly not a real analysis, ask them to try again. Do NOT skip this step.
5. **Photos**: Call request_photos. The user MUST send at least ${MIN_PHOTOS} photos — this is a hard minimum. Anything beyond ${MIN_PHOTOS} is PURELY OPTIONAL. Once ${MIN_PHOTOS} verified photos have arrived, DO NOT ask for another one. Briefly offer the option ("you can send one more if you want, or we can move on") and default to moving on. Never chain "one more, one more" requests.
6. **Finalize**: Once ALL fields are collected, context dump saved, and at least ${MIN_PHOTOS} photos uploaded, call save_profile_data with all extracted data, then call finalize_onboarding.

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
- **Gender**: A clear answer identifying the user as a man or a woman (in their own language). Internally map to the tool enum.
- **Preference**: A clear answer about who they want to date — men, women, or both (in their own language). Internally map to the tool enum.
- **Hobbies**: Whatever the user shares. One hobby is enough. "No hobbies" / "ничего особенного" is a valid answer — save it and move on. NEVER ask for additional hobbies after the first reply.
- **Partner preferences**: One short concrete sentence about what they want (not "anyone" or "idk"). One sentence is plenty — don't ask for more detail once you have one.
- **Height**: A plausible number in cm (140-220) — if the user is unsure of cm, help convert from feet/inches

### Tracking what you've collected:
Before calling save_profile_data, mentally verify you have ALL of these with concrete values:
- Email verified, First name, Age, Gender, Preference, Height, Hobbies (whatever the user gave — even an empty list is fine), Partner preferences (one sentence), Context dump saved (via save_context_dump), Photos (${MIN_PHOTOS}+)

If ANY required field is missing or vague, go back and collect it before saving.

## Conversation Style
- Talk like a cool older friend — casual, warm, not cringe. Short sentences. Easy to scan.
- No formal phrases: no "Здравствуйте", no "Пожалуйста", no corporate speak. Use "ты" (informal) in Russian/Ukrainian.
- Use 1-2 emojis per message max, placed naturally. Never overload with emojis.
- Russian/Ukrainian slang is welcome when natural: вайб, метч, рил, кринж, го.
- One idea per message. Don't stack 3 questions in one bubble.
- Lead with the action, not the explanation. Tell the user what to do first, then why (if needed).
- Start with the Zero-Chat pitch: Gennety finds your match, proposes it, schedules the date — no swiping, no chatting. You just show up.
- Then move into email verification.
- You can combine related questions (e.g., "What's your name and how old are you?") but get clear answers before moving on.
- Match the user's language. If they switch, you switch.
- NEVER inject English words into non-English messages during onboarding. Specifically, when asking about gender or dating preference in Russian/Ukrainian (or any non-English language), do NOT write "male", "female", "men", "women", "both", or phrases like "ты male?" / "Male, female, or both?". Ask naturally in the user's language (e.g. in Russian: "Ты парень или девушка?", "Кто тебе нравится — парни, девушки или все?"; in Ukrainian: "Ти хлопець чи дівчина?", "Хто тобі подобається — хлопці, дівчата чи всі?"). Map the user's natural-language reply to the tool enum values internally — the enums (\`male\`/\`female\`, \`men\`/\`women\`/\`both\`) live only inside tool calls, never in chat messages.
- If the user goes off-topic, gently nudge them back — don't lecture.
- If a photo is rejected (no clear face), explain briefly and ask for another.
- NEVER use robotic transitions like "Отлично! Переходим к следующему шагу." or fake enthusiasm: "Невероятно!", "Потрясающе!"

## Important
- Do NOT hallucinate or assume values. If the answer is ambiguous, ASK AGAIN — never guess.
- Call tools when appropriate — don't just talk about doing things.
- After finalize_onboarding, tell the user they're in and that you'll reach out when there's a match. Keep it brief.`;

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
        "Process and save the raw LLM context dump the user pasted back from their ChatGPT/Claude. Call this when the user sends a long message that looks like a psychological profile analysis (contains sections like values, attachment style, fears, etc.).",
      parameters: {
        type: "object",
        properties: {
          raw_dump: {
            type: "string",
            description:
              "The full text the user pasted — the output from their personal LLM.",
          },
        },
        required: ["raw_dump"],
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
          age: { type: "integer", description: "User's age (18-35)" },
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
  const otp = generateOtp(OTP_LENGTH);
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);

  await prisma.user.update({
    where: { telegramId },
    data: {
      email,
      universityDomain: domain,
      emailOtp: otp,
      emailOtpExpiresAt: expiresAt,
    },
  });

  try {
    const send = deps.sendOtp ?? sendOtpEmail;
    await send(email, otp);
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

  const otp = generateOtp(OTP_LENGTH);
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);

  await prisma.user.update({
    where: { telegramId },
    data: { emailOtp: otp, emailOtpExpiresAt: expiresAt },
  });

  try {
    const send = deps.sendOtp ?? sendOtpEmail;
    await send(user.email, otp);
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
    select: { emailOtp: true, emailOtpExpiresAt: true },
  });

  if (!user?.emailOtp || !user.emailOtpExpiresAt) {
    return JSON.stringify({
      success: false,
      error: "No pending OTP. Please provide your email first.",
    });
  }

  if (new Date() > user.emailOtpExpiresAt) {
    await prisma.user.update({
      where: { telegramId },
      data: { emailOtp: null, emailOtpExpiresAt: null },
    });
    return JSON.stringify({
      success: false,
      error: "OTP expired. Use the resend_otp tool to send a new code.",
    });
  }

  if (args.code.trim() !== user.emailOtp) {
    return JSON.stringify({ success: false, error: "Incorrect OTP code. Try again." });
  }

  await prisma.user.update({
    where: { telegramId },
    data: { emailOtp: null, emailOtpExpiresAt: null },
  });

  return JSON.stringify({
    success: true,
    message: "Email verified successfully!",
  });
}

async function execSaveContextDump(
  telegramId: bigint,
  args: { raw_dump?: unknown },
  deps: AgentDeps,
): Promise<string> {
  if (typeof args.raw_dump !== "string") {
    return JSON.stringify({
      success: false,
      error:
        "Missing or invalid raw_dump argument. You must pass the user's pasted text as raw_dump. Do NOT call save_context_dump until the user has actually pasted their ChatGPT/Claude analysis.",
    });
  }
  const raw = args.raw_dump.trim();
  if (raw.length < 200) {
    return JSON.stringify({
      success: false,
      error:
        "The text is too short to be a valid context dump. Ask the user to paste the full output from their ChatGPT/Claude.",
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
  });
}

async function execSaveProfileData(
  telegramId: bigint,
  args: {
    first_name: string;
    age: number;
    gender: "male" | "female";
    preference: "men" | "women" | "both";
    ethnicity?: string;
    height?: number;
    hobbies?: string[];
    partner_preferences?: string;
  },
  deps: AgentDeps,
): Promise<string> {
  if (args.age < MIN_AGE || args.age > MAX_AGE) {
    return JSON.stringify({
      success: false,
      error: `Age must be between ${MIN_AGE} and ${MAX_AGE}.`,
    });
  }

  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: { id: true },
  });
  if (!user) {
    return JSON.stringify({ success: false, error: "User not found." });
  }

  await prisma.user.update({
    where: { telegramId },
    data: {
      firstName: args.first_name,
      age: args.age,
      gender: args.gender,
      preference: args.preference,
    },
  });

  await prisma.profile.upsert({
    where: { userId: user.id },
    create: {
      userId: user.id,
      ethnicity: args.ethnicity ?? null,
      height: args.height ?? null,
      hobbies: args.hobbies ?? [],
      partnerPreferences: args.partner_preferences ?? null,
    },
    update: {
      ethnicity: args.ethnicity ?? null,
      height: args.height ?? null,
      hobbies: args.hobbies ?? [],
      partnerPreferences: args.partner_preferences ?? null,
    },
  });

  // Generate embedding from the profile data for matching
  const embeddingInput = [
    args.first_name,
    `Gender: ${args.gender}`,
    `Looking for: ${args.preference}`,
    args.ethnicity ? `Ethnicity: ${args.ethnicity}` : "",
    args.height ? `Height: ${args.height}cm` : "",
    args.hobbies?.length ? `Hobbies: ${args.hobbies.join(", ")}` : "",
    args.partner_preferences
      ? `Partner preferences: ${args.partner_preferences}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  const analyse = deps.analyseProfile ?? analyseAndSaveProfile;
  try {
    await analyse(user.id, embeddingInput);
  } catch (err) {
    console.warn("Embedding generation failed during onboarding:", err);
  }

  return JSON.stringify({
    success: true,
    message: "Profile data saved successfully.",
  });
}

async function execFinalizeOnboarding(
  telegramId: bigint,
): Promise<string> {
  // Guard: verify all required profile data exists before finalizing
  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: {
      firstName: true,
      age: true,
      gender: true,
      preference: true,
      email: true,
      profile: {
        select: {
          height: true,
          hobbies: true,
          partnerPreferences: true,
          psychologicalSummary: true,
          photos: true,
        },
      },
    },
  });

  const missing: string[] = [];
  if (!user?.firstName) missing.push("first_name");
  if (!user?.age) missing.push("age");
  if (!user?.gender) missing.push("gender");
  if (!user?.preference) missing.push("preference");
  if (!user?.email) missing.push("email (not verified)");
  if (!user?.profile?.height) missing.push("height");
  // Hobbies are no longer a blocking requirement: whatever the user shared
  // (including "no hobbies" / an empty list) is a valid answer.
  if (!user?.profile?.partnerPreferences)
    missing.push("partner_preferences");
  if (!user?.profile?.psychologicalSummary)
    missing.push("context_dump (deep profile not yet saved)");
  if (!user?.profile?.photos?.length || user.profile.photos.length < MIN_PHOTOS)
    missing.push(`photos (need at least ${MIN_PHOTOS})`);

  if (missing.length > 0) {
    return JSON.stringify({
      success: false,
      error: `Cannot finalize — missing required data: ${missing.join(", ")}. Please collect these before calling finalize_onboarding.`,
    });
  }

  await prisma.user.update({
    where: { telegramId },
    data: {
      onboardingStep: "completed",
      status: "active",
      ...reEngagementStopPatch,
    },
  });

  return JSON.stringify({
    success: true,
    message: "Onboarding complete. User is now active.",
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

  return [
    ...systemMessages,
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
  userMessage: string,
  deps: AgentDeps = {},
): Promise<AgentTurnResult> {
  const fetchFn = deps.fetchFn ?? fetch;

  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: { messageHistory: true, language: true },
  });

  // Rebuild messages array from stored history
  const history: ChatMessage[] = (
    (user?.messageHistory ?? []) as unknown[]
  ).map((m) => m as unknown as ChatMessage);

  // Seed system prompt on first turn
  if (history.length === 0) {
    const langNote = user?.language
      ? `The user's preferred language is: ${user.language}. Respond in that language unless they switch.`
      : "";
    history.push({
      role: "system",
      content: `${SYSTEM_PROMPT}\n\n${langNote}`.trim(),
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
  let contextPromptRequested = false;
  let contextDumpStarted = false;

  // Loop: call OpenAI, handle tool_calls, repeat until we get a text reply
  const MAX_TOOL_ROUNDS = 8;
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await callOpenAI(truncateForApi(history), fetchFn);

    const choice = response.choices[0];
    if (!choice) break;

    const assistantMsg = choice.message;

    // Push assistant message to history
    history.push({
      role: "assistant",
      content: assistantMsg.content,
      ...(assistantMsg.tool_calls ? { tool_calls: assistantMsg.tool_calls } : {}),
    });

    // If no tool calls, we have the final reply
    if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
      break;
    }

    // Execute each tool call and append results
    for (const toolCall of assistantMsg.tool_calls) {
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
            contextPromptRequested = true;
            contextDumpStarted = true;
            result = JSON.stringify({
              success: true,
              message:
                "Magic Prompt has been sent to the user in a copyable code block right above your next message. " +
                "Now write ONE short message (2-3 sentences max) telling the user: " +
                "1) to copy the prompt above, paste it into their ChatGPT or Claude, and send you back whatever it outputs; " +
                "2) if the response is long and Telegram splits it into several messages, they should tap the Done button that will appear. " +
                "IMPORTANT: The prompt is already visible to the user above your message. " +
                "Do NOT say you will send it, do NOT say 'next message', do NOT include the prompt text yourself. " +
                "Refer to it as 'the prompt above' or 'the prompt I just sent'.",
            });
            break;
          case "save_context_dump":
            result = await execSaveContextDump(
              telegramId,
              args as { raw_dump?: unknown },
              deps,
            );
            break;
          case "request_photos":
            expectingPhoto = true;
            result = JSON.stringify({
              success: true,
              message: `Photo upload mode activated. Waiting for ${MIN_PHOTOS}-${MAX_PHOTOS} photos.`,
            });
            break;
          case "save_profile_data":
            result = await execSaveProfileData(
              telegramId,
              args as Parameters<typeof execSaveProfileData>[1],
              deps,
            );
            break;
          case "finalize_onboarding":
            result = await execFinalizeOnboarding(telegramId);
            {
              const parsed = JSON.parse(result) as { success: boolean };
              if (parsed.success) onboardingComplete = true;
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
    }
  }

  // Persist updated history + reset the re-engagement chain (user activity).
  await prisma.user.update({
    where: { telegramId },
    data: {
      messageHistory: history as unknown as Prisma.InputJsonValue[],
      ...onboardingActivityPatch(),
    },
  });

  // Extract final assistant reply
  const lastAssistant = [...history]
    .reverse()
    .find((m) => m.role === "assistant" && m.content);
  const reply = lastAssistant?.content ?? "Something went wrong on my end. Try again in a sec.";

  return { reply, expectingPhoto, onboardingComplete, contextPromptRequested, contextDumpStarted };
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
