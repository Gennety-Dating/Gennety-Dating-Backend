/**
 * Re-export of the shared guard (`utils/uuid.ts`), kept at this path because
 * every admin route already imports it from here. See that module for why a
 * non-UUID id must never reach Prisma.
 */
export { isUuid } from "../../utils/uuid.js";
