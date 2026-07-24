/**
 * Venue Intent V2 — in-chat vibe/chip flow (Telegram).
 *
 * Product decision (2026-07): the V2 concierge collects the departure origin in
 * the Location Mini App, then everything else happens IN THE CHAT, matching the
 * product's chat-first philosophy — the bot asks for a free-text vibe, runs the
 * V2 interpreter, and surfaces the interpreted canonical chips as toggleable
 * INLINE BUTTONS (not a Mini App screen). The user adjusts and taps Confirm; the
 * existing V2 engine (`confirmVenueIntent` → `selectAndFinalizeVenueIntentV2`)
 * then auto-selects the venue and drops the date card (§3.7a).
 *
 * This module owns only the Telegram PRESENTATION of the chips + the toggle /
 * confirm callbacks. Interpretation, ranking, and finalization stay in
 * `services/venue-intent-v2.ts`. The iOS client keeps its own native chip screen
 * via `/v1/matches/:id/venue-intent`, so the OpenAPI contract is untouched.
 *
 * Callback data must fit Telegram's 64-byte limit; a match UUID does not, so the
 * toggle/confirm callbacks carry no id — the actor's single in-flight
 * `negotiating_venue` match is resolved server-side from their Telegram id.
 */
import { InlineKeyboard } from "grammy";
import type { InlineKeyboardMarkup } from "grammy/types";
import { prisma } from "@gennety/db";
import {
  VENUE_EXPERIENCES,
  VENUE_AMBIENCES,
  VENUE_FORMATS,
  type VenueExperience,
  type VenueAmbience,
  type VenueFormat,
  type VenueIntentV2,
} from "@gennety/shared";
import type { BotContext } from "../../session.js";
import {
  getVenueChatDraft,
  saveVenueChatDraft,
  confirmVenueIntent,
} from "../../services/venue-intent-v2.js";

const CHIP_TOGGLE_PREFIX = "vic:t:";
const CHIP_CONFIRM = "vic:ok";
const MAX_PER_GROUP = 3; // mirrors the Mini App cap (toggleList slice(0, 3))

/** Localized chip labels — the exact strings the (retired-in-live) Mini App used. */
const CHIP_LABELS: Record<string, Record<string, string>> = {
  en: { conversation: "Easy conversation", coffee_treats: "Coffee & treats", meal_discovery: "Discover food", walk_view: "Walk & views", art_culture: "Art & culture", drinks_evening: "Evening drinks", playful_activity: "Playful activity", surprise_me: "Surprise me", quiet: "Quiet", cozy_public: "Cozy", lively: "Lively", design_forward: "Design-led", scenic: "Scenic", romantic_public: "Romantic", seated: "Seated", walking: "Walking", interactive: "Interactive", indoor: "Indoor", outdoor: "Outdoor" },
  ru: { conversation: "Спокойно поговорить", coffee_treats: "Кофе и десерт", meal_discovery: "Новая еда", walk_view: "Прогулка и виды", art_culture: "Искусство", drinks_evening: "Вечерние напитки", playful_activity: "Активность", surprise_me: "Удивите меня", quiet: "Тихо", cozy_public: "Уютно", lively: "Живо", design_forward: "Стильный дизайн", scenic: "Красивый вид", romantic_public: "Романтично", seated: "За столиком", walking: "Прогулка", interactive: "Интерактивно", indoor: "В помещении", outdoor: "На улице" },
  uk: { conversation: "Спокійно поговорити", coffee_treats: "Кава й десерт", meal_discovery: "Нова їжа", walk_view: "Прогулянка й краєвиди", art_culture: "Мистецтво", drinks_evening: "Вечірні напої", playful_activity: "Активність", surprise_me: "Здивуйте мене", quiet: "Тихо", cozy_public: "Затишно", lively: "Жваво", design_forward: "Стильний дизайн", scenic: "Гарний краєвид", romantic_public: "Романтично", seated: "За столиком", walking: "Прогулянка", interactive: "Інтерактивно", indoor: "У приміщенні", outdoor: "Надворі" },
  de: { conversation: "Gut reden", coffee_treats: "Kaffee & Süßes", meal_discovery: "Essen entdecken", walk_view: "Spaziergang & Aussicht", art_culture: "Kunst & Kultur", drinks_evening: "Drinks am Abend", playful_activity: "Aktivität", surprise_me: "Überrasch mich", quiet: "Ruhig", cozy_public: "Gemütlich", lively: "Lebhaft", design_forward: "Designorientiert", scenic: "Schöne Aussicht", romantic_public: "Romantisch", seated: "Sitzend", walking: "Spaziergang", interactive: "Interaktiv", indoor: "Drinnen", outdoor: "Draußen" },
  pl: { conversation: "Spokojna rozmowa", coffee_treats: "Kawa i słodkości", meal_discovery: "Odkrywanie jedzenia", walk_view: "Spacer i widoki", art_culture: "Sztuka i kultura", drinks_evening: "Wieczorne drinki", playful_activity: "Aktywność", surprise_me: "Zaskocz mnie", quiet: "Cicho", cozy_public: "Przytulnie", lively: "Żywo", design_forward: "Dobry design", scenic: "Widokowo", romantic_public: "Romantycznie", seated: "Przy stoliku", walking: "Spacer", interactive: "Interaktywnie", indoor: "W środku", outdoor: "Na zewnątrz" },
};

/** Localized chat copy for the chip card (feature-scoped, mirrors the Mini App). */
const CHAT_STRINGS: Record<string, {
  intro: string;
  confirmBtn: string;
  confirmedAck: string;
  needExperience: string;
  expired: string;
}> = {
  en: { intro: "Here's the vibe I picked up — tap to adjust, then confirm 👇", confirmBtn: "✅ Confirm this vibe", confirmedAck: "Vibe locked in ✅ I'm lining up the perfect spot — hang tight.", needExperience: "Pick at least one experience first.", expired: "That vibe card expired. Send me your vibe again in a message." },
  ru: { intro: "Вот какой вайб я уловил — поправь, если нужно, и подтверждай 👇", confirmBtn: "✅ Подтвердить вайб", confirmedAck: "Вайб зафиксирован ✅ Подбираю идеальное место — секунду.", needExperience: "Сначала выбери хотя бы один формат встречи.", expired: "Эта карточка вайба устарела. Просто пришли вайб ещё раз сообщением." },
  uk: { intro: "Ось який вайб я вловив — поправ, якщо треба, і підтверджуй 👇", confirmBtn: "✅ Підтвердити вайб", confirmedAck: "Вайб зафіксовано ✅ Добираю ідеальне місце — секунду.", needExperience: "Спершу обери хоча б один формат зустрічі.", expired: "Ця картка вайбу застаріла. Просто надішли вайб ще раз повідомленням." },
  de: { intro: "Das ist die Stimmung, die ich verstanden habe — anpassen, dann bestätigen 👇", confirmBtn: "✅ Stimmung bestätigen", confirmedAck: "Stimmung gespeichert ✅ Ich suche den perfekten Ort — einen Moment.", needExperience: "Wähle zuerst mindestens ein Erlebnis.", expired: "Diese Karte ist abgelaufen. Schick mir deine Stimmung einfach nochmal als Nachricht." },
  pl: { intro: "Oto klimat, który wychwyciłem — dostosuj i potwierdź 👇", confirmBtn: "✅ Potwierdź klimat", confirmedAck: "Klimat zapisany ✅ Szukam idealnego miejsca — chwila.", needExperience: "Najpierw wybierz co najmniej jeden rodzaj spotkania.", expired: "Ta karta wygasła. Po prostu wyślij mi swój klimat jeszcze raz w wiadomości." },
};

function strings(lang: string): (typeof CHAT_STRINGS)["en"] {
  return CHAT_STRINGS[lang] ?? CHAT_STRINGS.en!;
}

function chipLabel(lang: string, id: string): string {
  return CHIP_LABELS[lang]?.[id] ?? CHIP_LABELS.en?.[id] ?? id.replaceAll("_", " ");
}

type ChipGroup = "e" | "a" | "f";

/**
 * Build the toggle keyboard: every experience / ambience / format chip, two per
 * row, active ones prefixed ✓, then a full-width Confirm button. Callback data
 * is `vic:t:<group>:<id>` (well under 64 bytes) — the match is resolved from the
 * actor, so no id rides the button.
 */
export function buildVibeChipKeyboard(draft: VenueIntentV2, lang: string): InlineKeyboardMarkup {
  const kb = new InlineKeyboard();
  const groups: Array<{ group: ChipGroup; ids: readonly string[]; active: readonly string[] }> = [
    { group: "e", ids: VENUE_EXPERIENCES, active: draft.experiences },
    { group: "a", ids: VENUE_AMBIENCES, active: draft.ambiences },
    { group: "f", ids: VENUE_FORMATS, active: draft.formats },
  ];
  for (const { group, ids, active } of groups) {
    ids.forEach((id, index) => {
      const on = active.includes(id);
      kb.text(`${on ? "✓ " : ""}${chipLabel(lang, id)}`, `${CHIP_TOGGLE_PREFIX}${group}:${id}`);
      if (index % 2 === 1 || index === ids.length - 1) kb.row();
    });
  }
  kb.text(strings(lang).confirmBtn, CHIP_CONFIRM);
  return { inline_keyboard: kb.inline_keyboard };
}

/** Send the chip card in chat after an interpret produced a draft. */
export async function sendVibeChipCard(
  ctx: BotContext,
  draft: VenueIntentV2,
  lang: string,
): Promise<void> {
  await ctx.reply(strings(lang).intro, {
    reply_markup: buildVibeChipKeyboard(draft, lang),
  });
}

/** Decode a `vic:t:<group>:<id>` toggle callback into a validated chip. */
function decodeToggle(data: string): { group: ChipGroup; id: string } | null {
  if (!data.startsWith(CHIP_TOGGLE_PREFIX)) return null;
  const rest = data.slice(CHIP_TOGGLE_PREFIX.length);
  const sep = rest.indexOf(":");
  if (sep === -1) return null;
  const group = rest.slice(0, sep) as ChipGroup;
  const id = rest.slice(sep + 1);
  if (group === "e" && (VENUE_EXPERIENCES as readonly string[]).includes(id)) return { group, id };
  if (group === "a" && (VENUE_AMBIENCES as readonly string[]).includes(id)) return { group, id };
  if (group === "f" && (VENUE_FORMATS as readonly string[]).includes(id)) return { group, id };
  return null;
}

function toggleList<T extends string>(list: T[], value: T): T[] {
  return list.includes(value)
    ? list.filter((item) => item !== value)
    : [...list, value].slice(0, MAX_PER_GROUP);
}

/** Apply one toggle to a draft's chip arrays, returning the new selections. */
function applyToggle(
  draft: VenueIntentV2,
  group: ChipGroup,
  id: string,
): { experiences: VenueExperience[]; ambiences: VenueAmbience[]; formats: VenueFormat[] } {
  return {
    experiences: group === "e" ? toggleList(draft.experiences, id as VenueExperience) : draft.experiences,
    ambiences: group === "a" ? toggleList(draft.ambiences, id as VenueAmbience) : draft.ambiences,
    formats: group === "f" ? toggleList(draft.formats, id as VenueFormat) : draft.formats,
  };
}

async function resolveActorVenue(
  telegramId: number,
): Promise<{ matchId: string; userId: string } | null> {
  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(telegramId) },
    select: { id: true },
  });
  if (!user) return null;
  const match = await prisma.match.findFirst({
    where: { status: "negotiating_venue", OR: [{ userAId: user.id }, { userBId: user.id }] },
    select: { id: true },
  });
  return match ? { matchId: match.id, userId: user.id } : null;
}

/**
 * Dispatch a `vic:*` callback: toggle a chip (edit the keyboard in place) or
 * confirm the vibe (hand off to `confirmVenueIntent`, which auto-finalizes the
 * venue + drops the date card). Idempotent and safe against a stale card
 * (expired / already-confirmed intent).
 */
export async function handleVibeChipCallback(ctx: BotContext): Promise<void> {
  const data = ctx.callbackQuery?.data;
  const fromId = ctx.from?.id;
  if (!data || !fromId) return;
  const lang = ctx.session.language;

  const actor = await resolveActorVenue(fromId);
  if (!actor) {
    await ctx.answerCallbackQuery({ text: strings(lang).expired }).catch(() => undefined);
    return;
  }

  // Confirm — hand the draft to the V2 engine (validates, stores confirmed,
  // and finalizes in live mode). Needs ≥1 experience, like the Mini App.
  if (data === CHIP_CONFIRM) {
    const loaded = await getVenueChatDraft(actor.matchId, actor.userId);
    if (!loaded) {
      await ctx.answerCallbackQuery({ text: strings(lang).expired }).catch(() => undefined);
      return;
    }
    const { draft } = loaded;
    if (draft.state === "confirmed") {
      await ctx.answerCallbackQuery().catch(() => undefined);
      await ctx.editMessageReplyMarkup().catch(() => undefined);
      return;
    }
    if (draft.experiences.length === 0) {
      await ctx.answerCallbackQuery({ text: strings(lang).needExperience, show_alert: true }).catch(() => undefined);
      return;
    }
    const origin = draft.origin;
    if (!origin) {
      await ctx.answerCallbackQuery({ text: strings(lang).expired }).catch(() => undefined);
      return;
    }
    await confirmVenueIntent(actor.matchId, actor.userId, {
      experiences: draft.experiences,
      ambiences: draft.ambiences,
      formats: draft.formats,
      hardConstraints: draft.hardConstraints,
      origin,
    });
    await ctx.answerCallbackQuery().catch(() => undefined);
    // Replace the interactive card with a static ack (drops the keyboard).
    await ctx.editMessageText(strings(lang).confirmedAck).catch(() => undefined);
    return;
  }

  // Toggle — flip one chip and re-render the keyboard in place.
  const toggle = decodeToggle(data);
  if (!toggle) {
    await ctx.answerCallbackQuery().catch(() => undefined);
    return;
  }
  const loaded = await getVenueChatDraft(actor.matchId, actor.userId);
  if (!loaded || loaded.draft.state === "confirmed") {
    await ctx.answerCallbackQuery({ text: strings(lang).expired }).catch(() => undefined);
    return;
  }
  const next = applyToggle(loaded.draft, toggle.group, toggle.id);
  const updated = await saveVenueChatDraft(actor.matchId, actor.userId, next);
  await ctx.answerCallbackQuery().catch(() => undefined);
  if (updated) {
    await ctx
      .editMessageReplyMarkup({ reply_markup: buildVibeChipKeyboard(updated, lang) })
      .catch(() => undefined);
  }
}
