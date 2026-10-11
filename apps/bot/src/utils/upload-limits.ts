import { MulterError } from "multer";

/**
 * Ceilings on the NON-file parts of a multipart body, shared by every multer
 * config (audit B-07). Each config already capped the file's size, but multer's
 * defaults leave the rest unbounded — unlimited text fields, unlimited parts,
 * 1 MB per field — so a body of tiny parts was free to parse into memory.
 *
 * Generous on purpose: the longest text field any client sends is a chat turn
 * (4,000 characters, < 16 KB in UTF-8), and no route takes more than a handful
 * of fields.
 */
export const MULTIPART_FIELD_LIMITS = {
  fields: 20,
  fieldSize: 64 * 1024,
  parts: 30,
} as const;

/**
 * The status and body a multer refusal answers with: 413 for an oversized
 * file, 400 for every other malformed upload (wrong field name, too many
 * parts...). `error` is multer's own code (`LIMIT_FILE_SIZE`,
 * `LIMIT_UNEXPECTED_FILE`, ...) — the same shape the routes with their own
 * wrapper (`me.ts` photos, `chat.ts` images) have always answered.
 */
export function multerErrorResponse(
  err: unknown,
): { status: 413 | 400; body: { error: string } } | null {
  if (!(err instanceof MulterError)) return null;
  return {
    status: err.code === "LIMIT_FILE_SIZE" ? 413 : 400,
    body: { error: err.code },
  };
}
