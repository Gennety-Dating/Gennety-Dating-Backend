const activeFinalizations = new Map<string, Promise<void>>();

/**
 * Coalesce concurrent venue-finalization requests in this process. The
 * database status CAS remains the cross-process authority.
 */
export function runVenueFinalizationOnce(
  matchId: string,
  finalize: () => Promise<void>,
): Promise<void> {
  const active = activeFinalizations.get(matchId);
  if (active) return active;

  const run = finalize().finally(() => {
    if (activeFinalizations.get(matchId) === run) {
      activeFinalizations.delete(matchId);
    }
  });
  activeFinalizations.set(matchId, run);
  return run;
}
