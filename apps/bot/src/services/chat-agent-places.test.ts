import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Place scenes inside a chat turn (decision 2026-11-26): which turns get the
 * tools, the prompt block, search → scene → stored on the reply and returned
 * as `place`, one per reply, the line when the model writes none, and the note
 * the next turn reads. The scene itself: `chat-place-scene.test.ts`.
 */

const env = {
  OPENAI_API_KEY: "k",
  WISHLIST_FEATURE_ENABLED: false,
  AGENT_VIBE_CARDS_ENABLED: true,
  AGENT_PLACE_SCENES_ENABLED: true,
  AGENT_CONCEPT_ENABLED: false,
  PUBLIC_BASE_URL: "https://api.gennety.test",
  BOT_TOKEN: "t",
};
vi.mock("../config.js", () => ({ env }));

const USER = "11111111-1111-4111-8111-111111111111";
let optIn = true;

const messageCreate = vi.fn(async (a: { data: { content: string; attachment?: unknown } }) => ({
  id: "reply-1",
  content: a.data.content,
  createdAt: new Date("2026-11-26T08:00:00Z"),
}));
let historyRows: Array<Record<string, unknown>> = [];
const venueRows = [
  {
    id: "v1", placeId: "pl-1", name: "Win Bar", address: "Хрещатик 1", category: "lounge", priority: 1, lat: 50.45, lng: 30.52,
    utcOffsetMinutes: 120, openingHours: null, photoRefs: ["p"], rating: 4.6, userRatingCount: 100, priceLevel: null,
    vibeTags: [], facetTags: [], editorialSummary: "Wine bar", primaryType: null, googleMapsUri: null, createdAt: new Date("2026-01-01"),
  },
];
const curatedFindMany = vi.fn(async () => venueRows);
vi.mock("@gennety/db", () => ({
  prisma: {
    user: { findUnique: async () => ({ telegramId: 4242n, language: "ru", frequentPlacesOptIn: optIn, profile: { homeCityKey: "ua:kyiv" } }) },
    message: {
      create: (a: { data: { content: string } }) => messageCreate(a),
      findMany: async () => historyRows,
      delete: async () => undefined,
    },
    curatedVenue: { findMany: () => curatedFindMany() },
    userPlaceVisit: { findMany: async () => [] },
    match: { findMany: async () => [] },
    userHiddenPlace: { findMany: async () => [] },
  },
}));
vi.mock("./menu-agent.js", () => ({
  AGENT_TOOLS: [],
  TOOL_KINDS: {},
  MAX_WRITES_PER_TURN: 1,
  toolReportedSuccess: (r: string) => JSON.parse(r).success === true,
  executeAgentTool: async () => ({ result: "{}", receiptKey: null, action: null }),
}));
vi.mock("./prompt-builder.js", () => ({ buildSystemPrompt: async () => "ОБЩИЙ ПРОМПТ" }));
vi.mock("./chat-profile-tools.js", () => ({
  applyChatProfilePatch: async () => ({ ok: true }),
  attachChatProfilePhoto: async () => ({ ok: true }),
}));
vi.mock("./storage.js", () => ({ createChatImageSignedUrl: async (path: string) => `https://signed/${path}` }));
vi.mock("./chat-sessions.js", () => ({
  continueOrOpenChatSession: async () => "s1",
  touchChatSession: async () => undefined,
}));
vi.mock("./chat-session-digest.js", () => ({ afterChatTurn: () => undefined }));
vi.mock("./chat-person-card.js", () => ({ buildPersonCard: async () => null }));
const REVIEW_BOARD = [
  { author: "Olena Kovalenko", rating: 5, text: "Уютно, приятно посидеть вечером, вкусные сырники и хорошее вино.", when: "2 недели назад", source: "google", authorUri: null, authorPhotoUri: null, reviewUri: null, translated: false },
  { author: "Max", rating: 4, text: "Тихая музыка и отличный кофе, можно спокойно посидеть вдвоём и поговорить.", when: "месяц назад", source: "google", authorUri: null, authorPhotoUri: null, reviewUri: null, translated: false },
];
const loadPlaceReviews = vi.fn(async (..._args: unknown[]) => REVIEW_BOARD);
vi.mock("./place-reviews.js", () => ({ loadPlaceReviews: (...args: unknown[]) => loadPlaceReviews(...args) }));

type Sent = { tools: Array<{ function: { name: string } }>; messages: Array<{ role: string; content: unknown; tool_call_id?: string }> };
let queue: unknown[] = [];
const sent: Sent[] = [];
const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
  sent.push(JSON.parse(String(init.body)) as Sent);
  return { ok: true, json: async () => queue.shift() ?? plain };
}) as unknown as typeof fetch;

function calls(list: Array<{ name: string; args?: unknown }>) {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: list.map((c, i) => ({ id: `c${i}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } })),
        },
        finish_reason: "tool_calls",
      },
    ],
  };
}
const line = (content: string) => ({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] });
const plain = line("Там тихо до восьми — успеешь поговорить.");
const consent = async () => true;
const SCENE = { kind: "venue", title: "Win Bar", venues: [{ id: "v1" }] };

const { runChatTurn, turnTools } = await import("./chat-agent.js");
const { resetPlaceCatalogCache } = await import("./place-catalog.js");
const PLACES = new Set(["places"]);

beforeEach(() => {
  queue = [];
  sent.length = 0;
  optIn = true;
  historyRows = [{ id: "u1", role: "user", content: "куда сходить?", imageUrl: null, imageUrls: [] }];
  messageCreate.mockClear();
  curatedFindMany.mockClear();
  resetPlaceCatalogCache();
});

const toolNames = (turn = 0) => sent[turn]!.tools.map((tool) => tool.function.name);
const system = () => String(sent[0]!.messages[0]!.content);
const toolReply = (turn: number, id = "c0") =>
  JSON.parse(String(sent[turn]!.messages.find((m) => m.role === "tool" && m.tool_call_id === id)!.content));

describe("which turns get the place tools", () => {
  it("a build that sends `places`: search, scene and their places, with the rules", async () => {
    await runChatTurn({ userId: USER, text: "куда сходить?", imageUrls: [], chatCards: PLACES }, { fetchFn, consent });
    expect(toolNames()).toEqual(expect.arrayContaining(["search_venues", "show_place_scene", "get_my_places"]));
    expect(system()).toContain("### Places — search, then one scene");
    // Nothing is read before a tool asks.
    expect(curatedFindMany).not.toHaveBeenCalled();
  });

  it("frequent places off: no get_my_places, and a stray call is refused", async () => {
    optIn = false;
    queue = [calls([{ name: "get_my_places" }]), plain];
    await runChatTurn({ userId: USER, text: "что рядом с моими местами?", imageUrls: [], chatCards: PLACES }, { fetchFn, consent });
    expect(toolNames()).toContain("search_venues");
    expect(toolNames()).not.toContain("get_my_places");
    expect(toolReply(1)).toMatchObject({ success: false, error: "unknown_tool" });
  });

  it("an older build: no tools, no rules, a stray call refused", async () => {
    queue = [calls([{ name: "show_place_scene", args: SCENE }]), plain];
    const turn = await runChatTurn({ userId: USER, text: "куда сходить?", imageUrls: [] }, { fetchFn, consent });
    expect(toolNames()).not.toContain("search_venues");
    expect(system()).not.toContain("### Places");
    expect(toolReply(1)).toMatchObject({ success: false, error: "unknown_tool" });
    expect(turn.place).toBeUndefined();
  });

  it("tool names stay unique with every card on", () => {
    const names = turnTools({ wishlistCards: true, offerCards: true, guideCards: true, screenshotCards: true, memoryIdeas: true, agentMemory: true, reminders: true, vibeCards: true, placeScenes: true, myPlaces: true }).map((tool) => tool.function.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("search, then the scene", () => {
  it("search finds the place; the scene is stored on the reply and returned as `place`", async () => {
    queue = [calls([{ name: "search_venues", args: { query: "wine" } }]), calls([{ name: "show_place_scene", args: SCENE }]), plain];
    const turn = await runChatTurn({ userId: USER, text: "где выпить вина?", imageUrls: [], chatCards: PLACES }, { fetchFn, consent });
    expect(toolReply(1).venues[0]).toMatchObject({ id: "v1", name: "Win Bar", category: "Бар" });
    expect(toolReply(2)).toMatchObject({ success: true });
    // As stored: the route signs the photo (`placeSceneView`).
    expect(turn.place).toMatchObject({ kind: "place_scene", sceneKind: "venue", title: "Win Bar", venues: [{ id: "v1", name: "Win Bar", categoryLabel: "Бар", photoVenueId: "v1" }] });
    expect(turn.content).toBe("Там тихо до восьми — успеешь поговорить.");
    const stored = messageCreate.mock.calls.at(-1)![0].data.attachment as { kind: string; sceneKind: string };
    expect(stored).toMatchObject({ kind: "place_scene", sceneKind: "venue" });
    // One catalog read for the whole turn.
    expect(curatedFindMany).toHaveBeenCalledTimes(1);
  });

  it("reviews: the server fetches the board for the place id in their language; the row stores no review text", async () => {
    const args = { kind: "reviews", title: "Выбери вечер и загляни", venues: [{ id: "v1" }], dishes: [{ name: "сырники" }] };
    queue = [calls([{ name: "show_place_scene", args }]), plain];
    const turn = await runChatTurn({ userId: USER, text: "где поужинать?", imageUrls: [], chatCards: PLACES }, { fetchFn, consent });
    expect(loadPlaceReviews).toHaveBeenCalledWith("pl-1", "ru", expect.any(Date), {});
    expect(turn.place).toMatchObject({ sceneKind: "reviews", reviews: REVIEW_BOARD, dishes: [{ name: "сырники" }] });
    const stored = messageCreate.mock.calls.at(-1)![0].data.attachment as Record<string, unknown>;
    expect(stored).toMatchObject({ sceneKind: "reviews", reviews: [], reviewsFrom: { placeId: "pl-1", language: "ru" } });
    expect(JSON.stringify(stored)).not.toContain("Тихая музыка");
  });

  it("reviews with too few good ones: refused, the model is told to pick another kind", async () => {
    loadPlaceReviews.mockResolvedValueOnce([]);
    queue = [calls([{ name: "show_place_scene", args: { kind: "reviews", title: "x", venues: [{ id: "v1" }] } }]), plain];
    const turn = await runChatTurn({ userId: USER, text: "где поужинать?", imageUrls: [], chatCards: PLACES }, { fetchFn, consent });
    expect(toolReply(1)).toMatchObject({ success: false, error: "too_few_reviews" });
    expect(turn.place).toBeUndefined();
  });

  it("one scene per reply", async () => {
    queue = [calls([{ name: "show_place_scene", args: SCENE }, { name: "show_place_scene", args: SCENE }]), plain];
    await runChatTurn({ userId: USER, text: "куда?", imageUrls: [], chatCards: PLACES }, { fetchFn, consent });
    expect(toolReply(1, "c1")).toMatchObject({ success: false, error: "one_card_per_reply" });
  });

  it("no line after the scene: a short one in their language", async () => {
    queue = [calls([{ name: "show_place_scene", args: SCENE }]), line("")];
    const turn = await runChatTurn({ userId: USER, text: "куда?", imageUrls: [], chatCards: PLACES }, { fetchFn, consent });
    expect(turn.content).toBe("Смотри:");
    expect(turn.place).toBeDefined();
  });

  it("the next turn's model reads the scene under its earlier reply", async () => {
    queue = [calls([{ name: "show_place_scene", args: SCENE }]), plain];
    await runChatTurn({ userId: USER, text: "куда?", imageUrls: [], chatCards: PLACES }, { fetchFn, consent });
    const stored = messageCreate.mock.calls.at(-1)![0].data.attachment;
    sent.length = 0;
    historyRows = [
      { id: "u1", role: "user", content: "куда?", imageUrl: null, imageUrls: [] },
      { id: "a1", role: "assistant", content: "Там тихо.", imageUrl: null, imageUrls: [], attachment: stored },
      { id: "u2", role: "user", content: "а до скольки он?", imageUrl: null, imageUrls: [] },
    ];
    await runChatTurn({ userId: USER, text: "а до скольки он?", imageUrls: [], chatCards: PLACES }, { fetchFn, consent });
    const assistant = sent[0]!.messages.find((m) => m.role === "assistant");
    expect(String(assistant!.content)).toContain("[Place scene (venue) after this reply: «Win Bar» (id v1)");
  });
});
