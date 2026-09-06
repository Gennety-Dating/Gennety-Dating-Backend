import { describe, it, expect, vi } from "vitest";
import { fetchPlatformPage, fetchPosterImage, isPublicAddress } from "./safe-fetch.js";

/**
 * The perimeter tests. This module is the only place the bot opens a URL a
 * user typed, so the interesting cases are all refusals — a passing "it
 * fetched the page" test says very little, while a missing range here is an
 * SSRF.
 */

describe("isPublicAddress — IPv4", () => {
  it("accepts ordinary public addresses", () => {
    for (const address of ["1.1.1.1", "8.8.8.8", "23.62.14.1", "203.1.113.4"]) {
      expect(isPublicAddress(address), address).toBe(true);
    }
  });

  it("refuses every private, loopback and reserved range", () => {
    for (const address of [
      "0.0.0.0",
      "10.0.0.1",
      "100.64.0.1", // CGNAT
      "127.0.0.1",
      "169.254.169.254", // cloud metadata — the one that matters most
      "172.16.0.1",
      "172.31.255.254",
      "192.0.0.1",
      "192.0.2.1",
      "192.88.99.1",
      "192.168.1.1",
      "198.18.0.1",
      "198.51.100.1",
      "203.0.113.1",
      "224.0.0.1",
      "240.0.0.1",
      "255.255.255.255",
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });

  it("does not treat 172.15/172.32 as private — the /12 boundary is exact", () => {
    expect(isPublicAddress("172.15.0.1")).toBe(true);
    expect(isPublicAddress("172.32.0.1")).toBe(true);
  });
});

describe("isPublicAddress — IPv6", () => {
  it("accepts ordinary global unicast", () => {
    expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
    expect(isPublicAddress("2a00:1450:4001:81b::200e")).toBe(true);
  });

  it("refuses loopback, unspecified, unique-local, link-local and multicast", () => {
    for (const address of ["::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1"]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });

  it("refuses documentation and discard prefixes", () => {
    expect(isPublicAddress("2001:db8::1")).toBe(false);
    expect(isPublicAddress("100::1")).toBe(false);
  });

  it("judges v4-mapped and NAT64 addresses by the v4 they carry", () => {
    // The classic bypass: an IPv6-shaped literal that reaches loopback.
    expect(isPublicAddress("::ffff:127.0.0.1")).toBe(false);
    expect(isPublicAddress("::ffff:169.254.169.254")).toBe(false);
    expect(isPublicAddress("::ffff:8.8.8.8")).toBe(true);
    expect(isPublicAddress("64:ff9b::10.0.0.1")).toBe(false);
    expect(isPublicAddress("64:ff9b::1.1.1.1")).toBe(true);
  });

  it("refuses anything that is not an address at all", () => {
    expect(isPublicAddress("not-an-ip")).toBe(false);
    expect(isPublicAddress("999.1.1.1")).toBe(false);
    expect(isPublicAddress("")).toBe(false);
  });
});

/* ── the guarded request ────────────────────────────────────────────────── */

const publicResolver = vi.fn(async () => [{ address: "1.1.1.1", family: 4 }]) as never;

function response(init: {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
}): Response {
  return new Response(init.body ?? "", {
    status: init.status ?? 200,
    headers: init.headers ?? {},
  });
}

describe("fetchPlatformPage", () => {
  it("reads a page from an allowlisted host", async () => {
    const fetchFn = vi.fn(async () => response({ body: "<html>ok</html>" })) as never;
    const result = await fetchPlatformPage("https://www.tiktok.com/oembed?url=x", {
      fetchFn,
      resolver: publicResolver,
    });
    expect(result).toMatchObject({ ok: true, body: "<html>ok</html>" });
  });

  it("refuses a host that is not on the allowlist without making a request", async () => {
    const fetchFn = vi.fn();
    const result = await fetchPlatformPage("https://evil.example/x", {
      fetchFn: fetchFn as never,
      resolver: publicResolver,
    });
    expect(result).toEqual({ ok: false, error: "blocked" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("refuses when the allowlisted host resolves to a private address", async () => {
    const fetchFn = vi.fn();
    const result = await fetchPlatformPage("https://www.tiktok.com/t/ZTabc/", {
      fetchFn: fetchFn as never,
      resolver: (async () => [{ address: "169.254.169.254", family: 4 }]) as never,
    });
    expect(result).toEqual({ ok: false, error: "blocked" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("refuses when only ONE of several resolved addresses is private", async () => {
    const result = await fetchPlatformPage("https://www.tiktok.com/t/ZTabc/", {
      fetchFn: vi.fn() as never,
      resolver: (async () => [
        { address: "1.1.1.1", family: 4 },
        { address: "10.0.0.5", family: 4 },
      ]) as never,
    });
    expect(result).toEqual({ ok: false, error: "blocked" });
  });

  it("re-checks the allowlist at every redirect hop", async () => {
    const fetchFn = vi.fn(async (url: string) =>
      url.includes("vm.tiktok.com")
        ? response({ status: 301, headers: { location: "https://169.254.169.254/latest" } })
        : response({ body: "should never be read" }),
    ) as never;
    const result = await fetchPlatformPage("https://vm.tiktok.com/ZMabc/", {
      fetchFn,
      resolver: publicResolver,
    });
    expect(result).toEqual({ ok: false, error: "blocked" });
  });

  it("follows an in-allowlist redirect and reports the final URL", async () => {
    const fetchFn = vi.fn(async (url: string) =>
      url.includes("vm.tiktok.com")
        ? response({
            status: 302,
            headers: { location: "https://www.tiktok.com/@u/video/7301234567890123456" },
          })
        : response({ body: "<html>landed</html>" }),
    ) as never;
    const result = await fetchPlatformPage("https://vm.tiktok.com/ZMabc/", {
      fetchFn,
      resolver: publicResolver,
    });
    expect(result).toMatchObject({
      ok: true,
      finalUrl: "https://www.tiktok.com/@u/video/7301234567890123456",
    });
  });

  it("gives up rather than loop when a redirect chain never lands", async () => {
    const fetchFn = vi.fn(async () =>
      response({ status: 302, headers: { location: "https://www.tiktok.com/t/ZTnext/" } }),
    ) as never;
    const result = await fetchPlatformPage("https://www.tiktok.com/t/ZTabc/", {
      fetchFn,
      resolver: publicResolver,
    });
    expect(result).toEqual({ ok: false, error: "blocked" });
  });

  it("maps the statuses a user can actually cause to distinct errors", async () => {
    const cases: Array<[number, string]> = [
      [404, "not_found"],
      [410, "not_found"],
      [401, "private"],
      [403, "private"],
      [429, "rate_limited"],
    ];
    for (const [status, error] of cases) {
      const result = await fetchPlatformPage("https://www.instagram.com/reel/Cx1_ab-cdEF/", {
        fetchFn: (async () => response({ status })) as never,
        resolver: publicResolver,
      });
      expect(result, String(status)).toEqual({ ok: false, error });
    }
  });
});

describe("fetchPosterImage", () => {
  it("accepts a CDN host but not a page host", async () => {
    const fetchFn = vi.fn(async () => response({ body: "jpegbytes" })) as never;
    await expect(
      fetchPosterImage("https://p16-sign.tiktokcdn-us.com/cover.jpg", {
        fetchFn,
        resolver: publicResolver,
      }),
    ).resolves.toMatchObject({ ok: true });

    await expect(
      fetchPosterImage("https://www.tiktok.com/cover.jpg", {
        fetchFn,
        resolver: publicResolver,
      }),
    ).resolves.toEqual({ ok: false, error: "blocked" });
  });

  it("refuses a body that declares itself over the cap", async () => {
    const result = await fetchPosterImage("https://scontent.cdninstagram.com/c.jpg", {
      fetchFn: (async () =>
        response({ body: "x", headers: { "content-length": "99999999" } })) as never,
      resolver: publicResolver,
    });
    expect(result).toEqual({ ok: false, error: "too_large" });
  });
});
