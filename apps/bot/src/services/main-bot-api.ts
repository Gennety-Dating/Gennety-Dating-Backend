import type { Api, RawApi } from "grammy";

/**
 * Process-wide handle to the MAIN (@gennetybot) bot `Api`, set once at boot in
 * `index.ts`. Services that need to act as the main bot outside a handler
 * context (e.g. `founder-notify.ts` downloading a user's own profile photo
 * bytes to re-upload through a different bot) read it here instead of
 * threading `api` through every call site. Mirrors the admin server's lazy
 * `Api` reference. `null` until the bot has started.
 */
let mainApi: Api<RawApi> | null = null;

export function setMainBotApi(api: Api<RawApi>): void {
  mainApi = api;
}

export function getMainBotApi(): Api<RawApi> | null {
  return mainApi;
}
