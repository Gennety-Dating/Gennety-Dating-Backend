import { prisma } from "@gennety/db";
import { normalizeChannel } from "./growth.js";
import { UNATTRIBUTED_CHANNEL } from "./ad-spend.js";

/**
 * Every channel that currently EXISTS, in one place.
 *
 * Two callers need this set for two different reasons and must not disagree
 * about it: the phone form offers it as suggestions, and both write paths
 * validate against it (`classifyAdSpendChannel`). If the picker offered a
 * channel the validator then rejected — or the reverse — the founder would be
 * arguing with the form.
 *
 * Deliberately does NOT run `classifyAllUsers()`, unlike
 * `GET /admin/ad-spend/channels`. That route filters out test accounts because
 * a test account's channel is noise in a picker; here the question is only
 * "could this string ever join against a row", and a test account's channel
 * can. Paying a full-table health classification per write to remove a few
 * suggestions is not a trade worth making on the write path.
 *
 * Already-logged spend channels are unioned in on purpose: it keeps a row that
 * predates the validation editable instead of stranding it behind a rule that
 * did not exist when it was written.
 */
export async function loadKnownAdSpendChannels(): Promise<string[]> {
  const [userRows, spendRows] = await Promise.all([
    prisma.user.findMany({ select: { referralSource: true }, distinct: ["referralSource"] }),
    prisma.adSpend.findMany({ select: { channel: true }, distinct: ["channel"] }),
  ]);
  const channels = new Set<string>([UNATTRIBUTED_CHANNEL]);
  for (const row of userRows) channels.add(normalizeChannel(row.referralSource));
  for (const row of spendRows) channels.add(row.channel);
  return [...channels].sort();
}
