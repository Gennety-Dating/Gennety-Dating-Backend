import {staticFile} from "remotion";

/**
 * Brand tokens for the product film.
 *
 * These are the same values `GennetyAd.tsx` uses, which are in turn the bot's
 * date/match card palette (PRODUCT_SPEC §3.7a, gennety_design_system/DESIGN.md).
 * They are re-declared rather than imported because the ad component keeps them
 * module-private, and a 1700-line ad is the wrong thing for a second film to
 * depend on. If the palette moves, it moves in both places.
 */
export const INK = "#030303";
export const SOFT = "#F5F5F5";
export const WINE = "#8B253B";
export const WINE_LIGHT = "#D16B80";
export const MUTED = "#A7A2A6";
export const SURFACE = "#161616";
export const OUTLINE = "#1a1a1a";

export const asset = (path: string) => staticFile(path);

/**
 * The captured Mini App screen, after the crop that removes the iOS status bar
 * and Telegram's Russian nav row. Every phone-framed shot is laid out from this
 * ratio, so the frame can never disagree with the footage inside it.
 */
export const SCREEN_W = 592;
export const SCREEN_H = 1130;
export const SCREEN_RATIO = SCREEN_W / SCREEN_H;
