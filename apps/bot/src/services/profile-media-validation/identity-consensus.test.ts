import { describe, expect, it, vi } from "vitest";
import {
  evaluatePhotoCandidateConsensus,
  type PendingPhotoCandidate,
} from "./identity-consensus.js";
import type { FaceMatchResult } from "../face-match.js";

const start = Date.parse("2026-06-18T10:00:00.000Z");

function candidate(photoRef: string, offsetMinutes: number): PendingPhotoCandidate {
  return {
    version: 1,
    photoRef,
    profileMedia: { type: "photo", photo: photoRef },
    faceScore: 0,
    uploadedAt: new Date(start + offsetMinutes * 60_000).toISOString(),
    source: "mobile",
  };
}

function deps(matchingPairs: readonly string[]) {
  const pairs = new Set(matchingPairs.map(normalizePair));
  return {
    getPhotoBuffer: vi.fn(async (item: PendingPhotoCandidate) =>
      Buffer.from(item.photoRef),
    ),
    compareFaces: vi.fn(async (left: Buffer, right: Buffer): Promise<FaceMatchResult> => {
      const key = normalizePair([left.toString(), right.toString()].join("|"));
      return {
        ok: true,
        faceFound: true,
        similarity: pairs.has(key) ? 0.92 : 0.12,
      };
    }),
  };
}

function normalizePair(pair: string): string {
  return pair.split("|").sort().join("|");
}

describe("evaluatePhotoCandidateConsensus", () => {
  it("confirms two matching self photos immediately", async () => {
    const result = await evaluatePhotoCandidateConsensus(
      [candidate("self-1", 0), candidate("self-2", 1)],
      deps(["self-1|self-2"]),
    );

    expect(result.winner?.map((item) => item.photoRef)).toEqual([
      "self-1",
      "self-2",
    ]);
    expect(result.rejected).toEqual([]);
  });

  it("keeps self plus stranger pending when no cluster exists", async () => {
    const result = await evaluatePhotoCandidateConsensus(
      [candidate("self-1", 0), candidate("stranger-1", 1)],
      deps([]),
    );

    expect(result.winner).toBeNull();
    expect(result.rejected).toEqual([]);
  });

  it("confirms self and rejects the stranger after self, stranger, self", async () => {
    const result = await evaluatePhotoCandidateConsensus(
      [
        candidate("self-1", 0),
        candidate("stranger-1", 1),
        candidate("self-2", 2),
      ],
      deps(["self-1|self-2"]),
    );

    expect(result.winner?.map((item) => item.photoRef)).toEqual([
      "self-1",
      "self-2",
    ]);
    expect(result.rejected.map((item) => item.photoRef)).toEqual(["stranger-1"]);
  });

  it("does not anchor the stranger when the stranger photo arrives first", async () => {
    const result = await evaluatePhotoCandidateConsensus(
      [
        candidate("stranger-1", 0),
        candidate("self-1", 1),
        candidate("self-2", 2),
      ],
      deps(["self-1|self-2"]),
    );

    expect(result.winner?.map((item) => item.photoRef)).toEqual([
      "self-1",
      "self-2",
    ]);
    expect(result.rejected.map((item) => item.photoRef)).toEqual(["stranger-1"]);
  });

  it("leaves three different photos unconfirmed", async () => {
    const result = await evaluatePhotoCandidateConsensus(
      [
        candidate("person-a", 0),
        candidate("person-b", 1),
        candidate("person-c", 2),
      ],
      deps([]),
    );

    expect(result.winner).toBeNull();
  });

  it("counts a group photo when any face matches the owner", async () => {
    const result = await evaluatePhotoCandidateConsensus(
      [candidate("group-with-self", 0), candidate("self-1", 1)],
      deps(["group-with-self|self-1"]),
    );

    expect(result.winner?.map((item) => item.photoRef)).toEqual([
      "group-with-self",
      "self-1",
    ]);
  });

  it("breaks equal-size cluster ties by earliest uploaded photo", async () => {
    const result = await evaluatePhotoCandidateConsensus(
      [
        candidate("self-1", 0),
        candidate("friend-1", 1),
        candidate("friend-2", 2),
        candidate("self-2", 3),
      ],
      deps(["self-1|self-2", "friend-1|friend-2"]),
    );

    expect(result.winner?.map((item) => item.photoRef)).toEqual([
      "self-1",
      "self-2",
    ]);
    expect(result.rejected.map((item) => item.photoRef)).toEqual([
      "friend-1",
      "friend-2",
    ]);
  });
});
