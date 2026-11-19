import { Router, type Request, type Response } from "express";
import { prisma } from "@gennety/db";
import { requireAuth } from "../auth-middleware.js";
import { memoryIdeasLimiter } from "../rate-limit.js";
import { agentMemoryOn } from "../../services/feature-preview.js";
import { isUuid } from "../../utils/uuid.js";
import {
  AgentMemoryError,
  forgetAll,
  forgetNote,
  listNotes,
  setMemoryPaused,
  updateNote,
  type AgentMemoryNote,
} from "../../services/agent-memory.js";

/**
 * «Что Gennety помнит» for the native client (spec
 * `docs/product/domains/long-term-memory.md` phase 8.3). `/v1/me/memory` is
 * the ideas API, so this one lives at `/v1/me/agent-memory`.
 *
 * The owner is always the token's person. With the flag off a person can
 * still see and delete what exists and pause memory; only editing a note
 * needs memory on and unpaused, like the agent's own writes.
 */

/** A cluster on the screen: one person or story, or one kind of note. */
export type MemoryClusterKind = "person" | "story" | "about" | "followups" | "dates" | "stories";

export interface MemoryClusterDto {
  /** Stable within one response: `person:маша`, `kind:about`… */
  id: string;
  kind: MemoryClusterKind;
  /** The name for a person or story cluster; null for a kind cluster (the client names it). */
  title: string | null;
  notes: MemoryNoteDto[];
}

export interface MemoryNoteDto {
  id: string;
  kind: AgentMemoryNote["kind"];
  text: string;
  subject: string | null;
  date: string | null;
  everyYear: boolean;
  status: AgentMemoryNote["status"];
  outcome: string | null;
  /** told: they asked to remember; noticed: from a conversation. */
  provenance: AgentMemoryNote["provenance"];
  surface: AgentMemoryNote["surface"];
  /** When a conversation last confirmed it. */
  seenAt: string;
  createdAt: string;
}

function dto(note: AgentMemoryNote): MemoryNoteDto {
  return {
    id: note.id,
    kind: note.kind,
    text: note.text,
    subject: note.subject,
    date: note.dueOn,
    everyYear: note.recurring,
    status: note.status,
    outcome: note.outcome,
    provenance: note.provenance,
    surface: note.surface,
    seenAt: note.lastSeenAt.toISOString(),
    createdAt: note.createdAt.toISOString(),
  };
}

/** «Маша, сестра» / «Маша — сестра» → «Маша». */
function nameOf(subject: string): string {
  return subject.split(/\s*[,—–(:-]\s*/u)[0]!.trim();
}

const key = (name: string): string => name.toLocaleLowerCase().normalize("NFKC");

/**
 * Group notes for the screen. A person or a story with a subject is its own
 * cluster; any other note whose subject or text starts with that name — «День
 * рождения Маши» does not, «Маша считает…» does — joins it. Everything else
 * groups by kind. Order: people and stories by size, then the kind clusters.
 */
export function clusterNotes(notes: AgentMemoryNote[]): MemoryClusterDto[] {
  const named = new Map<string, MemoryClusterDto>();
  for (const note of notes) {
    if ((note.kind === "person" || note.kind === "story") && note.subject) {
      const name = nameOf(note.subject);
      if (!name) continue;
      const k = key(name);
      if (!named.has(k)) named.set(k, { id: `${note.kind}:${k}`, kind: note.kind, title: name, notes: [] });
      else if (note.kind === "person") named.get(k)!.kind = "person";
    }
  }
  const kinds: Record<string, MemoryClusterDto> = {};
  const kindCluster = (kind: MemoryClusterKind): MemoryClusterDto =>
    (kinds[kind] ??= { id: `kind:${kind}`, kind, title: null, notes: [] });

  for (const note of notes) {
    const subjectName = note.subject ? key(nameOf(note.subject)) : null;
    const textStart = key(note.text).split(/[^\p{L}\p{N}]+/u)[0] ?? "";
    const home = (subjectName && named.get(subjectName)) ?? (textStart ? named.get(textStart) : undefined);
    if (home) {
      home.notes.push(dto(note));
      continue;
    }
    const kind: MemoryClusterKind =
      note.kind === "fact" ? "about" : note.kind === "followup" ? "followups" : note.kind === "date" ? "dates" : note.kind === "story" ? "stories" : "about";
    kindCluster(kind).notes.push(dto(note));
  }
  const people = [...named.values()].filter((c) => c.notes.length > 0).sort((a, b) => b.notes.length - a.notes.length);
  const order: MemoryClusterKind[] = ["about", "stories", "followups", "dates"];
  return [...people, ...order.flatMap((k) => (kinds[k] ? [kinds[k]!] : []))];
}

export function createAgentMemoryRouter(): Router {
  const router = Router();
  router.use(requireAuth);
  router.use(memoryIdeasLimiter);

  const userOf = (req: Request): string => req.userId as string;
  const guarded =
    (handler: (req: Request, res: Response) => Promise<void>) =>
    async (req: Request, res: Response): Promise<void> => {
      try {
        await handler(req, res);
      } catch (err) {
        if (err instanceof AgentMemoryError) {
          const status = err.code === "not-found" ? 404 : err.code === "paused" ? 409 : 422;
          res.status(status).json({ error: err.code });
          return;
        }
        throw err;
      }
    };
  const noteId = (req: Request, res: Response): string | null => {
    const id = String(req.params.id);
    if (isUuid(id)) return id;
    res.status(400).json({ error: "bad-request" });
    return null;
  };

  /** The whole screen in one read. */
  router.get(
    "/",
    guarded(async (req, res) => {
      const userId = userOf(req);
      const [notes, state] = await Promise.all([
        listNotes(userId),
        prisma.agentMemoryState.findUnique({ where: { userId }, select: { pausedAt: true } }),
      ]);
      res.json({ enabled: agentMemoryOn(userId), paused: Boolean(state?.pausedAt), count: notes.length, clusters: clusterNotes(notes) });
    }),
  );

  /** The «Запоминать» switch. */
  router.patch(
    "/",
    guarded(async (req, res) => {
      const paused = (req.body as Record<string, unknown> | undefined)?.paused;
      if (typeof paused !== "boolean") {
        res.status(400).json({ error: "bad-request" });
        return;
      }
      await setMemoryPaused(userOf(req), paused);
      res.json({ paused });
    }),
  );

  /** «Исправить»: new text for one note. */
  router.patch(
    "/notes/:id",
    guarded(async (req, res) => {
      const id = noteId(req, res);
      if (!id) return;
      const userId = userOf(req);
      if (!agentMemoryOn(userId)) {
        res.status(404).json({ error: "feature-disabled" });
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.text !== "string" || !body.text.trim()) {
        res.status(400).json({ error: "bad-request" });
        return;
      }
      const note = await updateNote(userId, id, { text: body.text, surface: "app" });
      res.json(dto(note));
    }),
  );

  /** «Забыть» one note — a hard delete. */
  router.delete(
    "/notes/:id",
    guarded(async (req, res) => {
      const id = noteId(req, res);
      if (!id) return;
      await forgetNote(userOf(req), id);
      res.status(204).end();
    }),
  );

  /** «Забыть всё». The client asks first; the chats themselves stay. */
  router.delete(
    "/notes",
    guarded(async (req, res) => {
      res.json({ forgotten: await forgetAll(userOf(req)) });
    }),
  );

  return router;
}
