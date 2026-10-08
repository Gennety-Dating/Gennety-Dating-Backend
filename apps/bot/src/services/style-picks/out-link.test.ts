import { describe, expect, it } from "vitest";
import { shopUrl, signStyleOut, styleOutExpiry, styleOutSignatureValid, styleOutUrl } from "./out-link.js";
import { item } from "./__fixtures__/fixtures.js";

const USER = "11111111-1111-4111-8111-111111111111";
const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);

describe("signed outbound links", () => {
  it("verifies its own signature and nothing else", () => {
    const exp = styleOutExpiry(NOW);
    const sig = signStyleOut(USER, "matsuda-m3023", exp);
    expect(styleOutSignatureValid(USER, "matsuda-m3023", exp, sig, NOW)).toBe(true);
    expect(styleOutSignatureValid(USER, "kiehls-lip-balm-1", exp, sig, NOW)).toBe(false);
    expect(styleOutSignatureValid("22222222-2222-4222-8222-222222222222", "matsuda-m3023", exp, sig, NOW)).toBe(false);
    expect(styleOutSignatureValid(USER, "matsuda-m3023", exp + 1, sig, NOW)).toBe(false);
    expect(styleOutSignatureValid(USER, "matsuda-m3023", exp, "short", NOW)).toBe(false);
  });

  it("expires", () => {
    const exp = styleOutExpiry(NOW);
    const sig = signStyleOut(USER, "x", exp);
    expect(styleOutSignatureValid(USER, "x", exp, sig, exp + 1)).toBe(false);
    expect(exp).toBeGreaterThan(NOW + 6 * 86_400_000);
  });

  it("mints the same link all day, carrying no personal data beyond the opaque id", () => {
    const a = styleOutUrl(USER, "x", "uk", NOW);
    const b = styleOutUrl(USER, "x", "uk", NOW + 3_600_000);
    expect(a).toBe(b);
    const url = new URL(a);
    expect(url.pathname).toBe("/v1/style/out/x");
    expect([...url.searchParams.keys()].sort()).toEqual(["e", "l", "s", "u"]);
  });
});

describe("shopUrl", () => {
  const product = item("jo-malone", {
    category: "scent",
    url: "https://www.breuninger.com/p/?ref=1",
    urlUA: "https://makeup.com.ua/product/202125/",
    affiliateParams: { aff_id: "gennety42" },
  });

  it("adds the UTM tags and the affiliate parameters", () => {
    const url = new URL(shopUrl(product, "en"));
    expect(url.origin + url.pathname).toBe("https://www.breuninger.com/p/");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      ref: "1",
      utm_source: "gennety",
      utm_medium: "app",
      utm_campaign: "style_picks",
      utm_content: "scent",
      aff_id: "gennety42",
    });
  });

  it("sends a Ukrainian reader to the Ukrainian shop when there is one", () => {
    expect(new URL(shopUrl(product, "uk")).host).toBe("makeup.com.ua");
    expect(new URL(shopUrl({ ...product, urlUA: null }, "uk")).host).toBe("www.breuninger.com");
    expect(new URL(shopUrl(product, null)).host).toBe("www.breuninger.com");
  });
});
