import { normalizeMusicArtists, normalizeMusicTitle, type MusicTrack } from "../music/track.js";

/**
 * A track from YouTube, Yandex Music or SoundCloud has no id a profile can
 * keep — the profile speaks Spotify and Apple Music only, because their
 * metadata is re-read weekly and a removed track disappears. So such a track
 * is looked up in Spotify's catalogue (the search the profile already uses)
 * and kept only on a confident hit: the same song name and at least one
 * shared artist. A near miss stays unmatched rather than pinning the wrong
 * song to somebody's profile.
 */

/** The search text for one source track: primary artist and the song's core name. */
export function matchQuery(title: string, artists: string): string {
  const core = title.replace(/[([{【][^)\]}】]*[)\]}】]/gu, " ").replace(/\s+/gu, " ").trim() || title;
  const primary = artists.split(/\s*(?:,|&|\bfeat\.?|\bft\.?)\s*/iu)[0]?.trim() ?? "";
  return `${primary} ${core}`.trim().slice(0, 100);
}

/**
 * Same core name, exactly: brackets, «- Remastered 2011» and «feat. …» are cut
 * on both sides first (`normalizeMusicTitle`), so «Song (Official Video)» and
 * «Song - 2011 Remaster» agree while «Song» and «Song Remix» do not.
 */
function titlesAgree(a: string, b: string): boolean {
  const x = normalizeMusicTitle(a);
  return x !== "" && x === normalizeMusicTitle(b);
}

function artistsAgree(source: string, candidate: string): boolean {
  const wanted = normalizeMusicArtists(source);
  // A source that names no artist cannot vouch for one: no match.
  if (wanted.length === 0) return false;
  const offered = normalizeMusicArtists(candidate);
  return wanted.some((name) =>
    offered.some((other) => other === name || other.replace(/ /gu, "") === name.replace(/ /gu, "")),
  );
}

/** The first search result that is confidently the same song, or null. */
export function pickMatch(title: string, artists: string, results: readonly MusicTrack[]): MusicTrack | null {
  return results.find((result) => titlesAgree(title, result.title) && artistsAgree(artists, result.artists)) ?? null;
}
