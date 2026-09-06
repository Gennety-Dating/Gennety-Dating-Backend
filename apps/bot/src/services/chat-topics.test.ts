import { describe, it, expect } from "vitest";

import {
  TOPIC_GAP_MS,
  TOPIC_SNIPPET_MAX,
  TOPIC_TITLE_MAX,
  segmentTopics,
  type TopicSourceMessage,
} from "./chat-topics.js";

const T0 = new Date("2026-09-01T10:00:00.000Z").getTime();

function msg(
  id: string,
  role: TopicSourceMessage["role"],
  content: string,
  offsetMs: number,
): TopicSourceMessage {
  return { id, role, content, createdAt: new Date(T0 + offsetMs) };
}

const MINUTE = 60_000;

describe("segmentTopics", () => {
  it("returns nothing for an empty stream", () => {
    expect(segmentTopics([])).toEqual([]);
  });

  it("keeps one unbroken conversation as a single topic", () => {
    const topics = segmentTopics([
      msg("a", "user", "привет", 0),
      msg("b", "assistant", "привет, рассказывай", MINUTE),
      msg("c", "user", "люблю бегать по утрам", 2 * MINUTE),
    ]);

    expect(topics).toHaveLength(1);
    expect(topics[0]!.anchorId).toBe("a");
    expect(topics[0]!.title).toBe("привет");
    expect(topics[0]!.snippet).toBe("люблю бегать по утрам");
    expect(topics[0]!.messageCount).toBe(3);
    expect(topics[0]!.depth).toBe(3);
  });

  it("cuts a new topic on a silence longer than the gap, newest first", () => {
    const topics = segmentTopics([
      msg("a", "user", "первый разговор", 0),
      msg("b", "assistant", "ответ", MINUTE),
      msg("c", "user", "второй разговор", TOPIC_GAP_MS + 2 * MINUTE),
      msg("d", "assistant", "второй ответ", TOPIC_GAP_MS + 3 * MINUTE),
    ]);

    expect(topics.map((t) => t.anchorId)).toEqual(["c", "a"]);
    expect(topics[0]!.title).toBe("второй разговор");
    expect(topics[1]!.title).toBe("первый разговор");
  });

  it("does not cut exactly at the gap — only strictly beyond it", () => {
    const topics = segmentTopics([
      msg("a", "user", "до паузы", 0),
      msg("b", "user", "ровно на границе", TOPIC_GAP_MS),
    ]);

    expect(topics).toHaveLength(1);
  });

  it("counts depth from the anchor to the newest message", () => {
    // Three topics of two messages each; the oldest anchor is six messages
    // from the end, and the client sizes its paging on exactly that.
    const topics = segmentTopics([
      msg("a", "user", "один", 0),
      msg("b", "assistant", "..", MINUTE),
      msg("c", "user", "два", 2 * TOPIC_GAP_MS),
      msg("d", "assistant", "..", 2 * TOPIC_GAP_MS + MINUTE),
      msg("e", "user", "три", 4 * TOPIC_GAP_MS),
      msg("f", "assistant", "..", 4 * TOPIC_GAP_MS + MINUTE),
    ]);

    expect(topics.map((t) => t.depth)).toEqual([2, 4, 6]);
  });

  it("titles a topic with the user's first line, not the assistant's", () => {
    const topics = segmentTopics([
      msg("a", "assistant", "я тут подумал о твоём профиле", 0),
      msg("b", "user", "давай про фотографии", MINUTE),
    ]);

    expect(topics[0]!.title).toBe("давай про фотографии");
    expect(topics[0]!.anchorId).toBe("a");
  });

  it("falls back to the assistant when the user never answered", () => {
    const topics = segmentTopics([
      msg("a", "assistant", "не пропадай, скоро дроп", 0),
    ]);

    expect(topics[0]!.title).toBe("не пропадай, скоро дроп");
  });

  it("drops system rows so an anchor is always a message the client renders", () => {
    const topics = segmentTopics([
      msg("s", "system", "служебное", 0),
      msg("a", "user", "видимое", MINUTE),
    ]);

    expect(topics).toHaveLength(1);
    expect(topics[0]!.anchorId).toBe("a");
    expect(topics[0]!.messageCount).toBe(1);
    expect(topics[0]!.depth).toBe(1);
  });

  it("does not let a system row alone hold a topic open", () => {
    // Without the filter this would read as one topic spanning the silence,
    // because the system row sits inside the gap and bridges it.
    const topics = segmentTopics([
      msg("a", "user", "раньше", 0),
      msg("s", "system", "служебное", TOPIC_GAP_MS - MINUTE),
      msg("b", "user", "позже", 2 * TOPIC_GAP_MS - 2 * MINUTE),
    ]);

    expect(topics.map((t) => t.anchorId)).toEqual(["b", "a"]);
  });

  it("condenses a long title on a word boundary and marks the cut", () => {
    const long = "слово ".repeat(40).trim();
    const topics = segmentTopics([msg("a", "user", long, 0)]);

    const title = topics[0]!.title;
    expect(title.length).toBeLessThanOrEqual(TOPIC_TITLE_MAX + 1);
    expect(title.endsWith("…")).toBe(true);
    expect(title).not.toContain(" …");
  });

  it("collapses newlines so a row stays one line", () => {
    const topics = segmentTopics([
      msg("a", "user", "первая строка\n\n   вторая строка", 0),
    ]);

    expect(topics[0]!.title).toBe("первая строка вторая строка");
  });

  it("cuts mid-word rather than throw away most of a long unbroken run", () => {
    const wall = "ф".repeat(300);
    const topics = segmentTopics([msg("a", "user", `${wall}`, 0)]);

    expect(topics[0]!.title.length).toBe(TOPIC_TITLE_MAX + 1); // + ellipsis
  });

  it("snippets the last message of the topic, not the first", () => {
    const topics = segmentTopics([
      msg("a", "user", "начало", 0),
      msg("b", "assistant", "конец", MINUTE),
    ]);

    expect(topics[0]!.snippet).toBe("конец");
    expect(TOPIC_SNIPPET_MAX).toBeGreaterThan(TOPIC_TITLE_MAX);
  });

  it("reports the real boundaries of the topic in time", () => {
    const topics = segmentTopics([
      msg("a", "user", "начало", 0),
      msg("b", "assistant", "конец", 5 * MINUTE),
    ]);

    expect(topics[0]!.startedAt).toBe(new Date(T0).toISOString());
    expect(topics[0]!.updatedAt).toBe(new Date(T0 + 5 * MINUTE).toISOString());
  });
});
