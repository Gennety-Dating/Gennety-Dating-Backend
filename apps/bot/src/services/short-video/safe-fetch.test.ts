import { describe, it, expect, vi } from "vitest";
import {
  fetchPlatformPage,
  fetchPosterImage,
  fetchPublicImage,
  fetchPublicPage,
  isPublicAddress,
  isPublicWebHostname,
} from "./safe-fetch.js";

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

/* ── open-host fetches (Date Wishlist) ──────────────────────────────────── */

describe("isPublicWebHostname", () => {
  it("accepts ordinary shop hostnames, IDNs and CDN names", () => {
    for (const host of [
      "www.sephora.de",
      "chloe.com",
      "example.com",
      "shop_1.myshopify.com",
      "xn--80ak6aa92e.com",
      "shop.xn--j1amh",
      "cdn.shopify.com.",
    ]) {
      expect(isPublicWebHostname(host), host).toBe(true);
    }
  });

  it("refuses IP literals, single labels and internal-only names", () => {
    for (const host of [
      "localhost",
      "LOCALHOST.",
      "api.localhost",
      "intranet",
      "printer.lan",
      "nas.local",
      "metadata.google.internal",
      "router.home.arpa",
      "1.0.0.127.in-addr.arpa",
      "db.corp",
      "127.0.0.1",
      "169.254.169.254",
      "[::1]",
      "::ffff:127.0.0.1",
      "foo.123",
      "a..b.com",
      "-bad.com",
      "",
    ]) {
      expect(isPublicWebHostname(host), host).toBe(false);
    }
  });
});

/** Per-host DNS for the open-host tests: anything under `internal-pointer.com` is internal. */
const splitResolver = (async (host: string) =>
  host.endsWith("internal-pointer.com")
    ? [{ address: "10.0.0.7", family: 4 }]
    : [{ address: "93.184.216.34", family: 4 }]) as never;

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);

function imageResponse(body: Buffer, headers: Record<string, string>): Response {
  return new Response(new Uint8Array(body), { headers });
}

describe("fetchPublicPage", () => {
  it("reads a page from any public host and reports the final URL", async () => {
    const fetchFn = vi.fn(async () =>
      response({ body: "<html>shop</html>", headers: { "content-type": "text/html; charset=utf-8" } }),
    );
    const result = await fetchPublicPage("https://www.douglas.de/de/p/123", {
      fetchFn: fetchFn as never,
      resolver: splitResolver,
    });
    expect(result).toEqual({
      ok: true,
      body: "<html>shop</html>",
      finalUrl: "https://www.douglas.de/de/p/123",
    });
  });

  it("upgrades http to https before the request goes out", async () => {
    const fetchFn = vi.fn(async (_url: string) => response({ body: "ok" }));
    await fetchPublicPage("http://shop.example.com/item", {
      fetchFn: fetchFn as never,
      resolver: splitResolver,
    });
    expect(fetchFn.mock.calls[0]?.[0]).toBe("https://shop.example.com/item");
  });

  it("refuses IP literals, localhost, odd ports and credentials without a request", async () => {
    for (const url of [
      "https://127.0.0.1/",
      "https://2130706433/", // 127.0.0.1 in integer form
      "https://0x7f.1/",
      "https://[::1]/",
      "https://169.254.169.254/latest/meta-data/",
      "https://localhost/",
      "https://shop.example.com:8443/",
      "https://user:pass@shop.example.com/",
      "ftp://shop.example.com/",
      "javascript:alert(1)",
      "not a url",
    ]) {
      const fetchFn = vi.fn();
      const result = await fetchPublicPage(url, {
        fetchFn: fetchFn as never,
        resolver: splitResolver,
      });
      expect(result, url).toEqual({ ok: false, error: "blocked" });
      expect(fetchFn, url).not.toHaveBeenCalled();
    }
  });

  it("refuses a public-looking name that resolves to a private address", async () => {
    const fetchFn = vi.fn();
    const result = await fetchPublicPage("https://shop.internal-pointer.com/p", {
      fetchFn: fetchFn as never,
      resolver: splitResolver,
    });
    expect(result).toEqual({ ok: false, error: "blocked" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("refuses a redirect to a host that resolves to a private address", async () => {
    const fetchFn = vi.fn(async (url: string) =>
      url.startsWith("https://shop.example.com")
        ? response({ status: 302, headers: { location: "https://go.internal-pointer.com/admin" } })
        : response({ body: "internal secrets" }),
    );
    const result = await fetchPublicPage("https://shop.example.com/p", {
      fetchFn: fetchFn as never,
      resolver: splitResolver,
    });
    expect(result).toEqual({ ok: false, error: "blocked" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("refuses a redirect to an IP literal (the cloud metadata address)", async () => {
    const fetchFn = vi.fn(async (url: string) =>
      url.startsWith("https://shop.example.com")
        ? response({ status: 301, headers: { location: "http://169.254.169.254/metadata/v1/" } })
        : response({ body: "metadata" }),
    );
    const result = await fetchPublicPage("https://shop.example.com/p", {
      fetchFn: fetchFn as never,
      resolver: splitResolver,
    });
    expect(result).toEqual({ ok: false, error: "blocked" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("follows a public redirect across hosts", async () => {
    const fetchFn = vi.fn(async (url: string) =>
      url.startsWith("https://bit.example.com")
        ? response({ status: 302, headers: { location: "https://www.zalando.de/item.html" } })
        : response({ body: "<html>landed</html>", headers: { "content-type": "text/html" } }),
    );
    const result = await fetchPublicPage("https://bit.example.com/x", {
      fetchFn: fetchFn as never,
      resolver: splitResolver,
    });
    expect(result).toMatchObject({ ok: true, finalUrl: "https://www.zalando.de/item.html" });
  });

  it("refuses a response that is not a page", async () => {
    const result = await fetchPublicPage("https://shop.example.com/file", {
      fetchFn: (async () =>
        response({ body: "PK", headers: { "content-type": "application/zip" } })) as never,
      resolver: splitResolver,
    });
    expect(result).toEqual({ ok: false, error: "blocked" });
  });

  it("refuses a page over the byte cap", async () => {
    const result = await fetchPublicPage("https://shop.example.com/huge", {
      fetchFn: (async () =>
        response({ body: "x", headers: { "content-length": "99999999" } })) as never,
      resolver: splitResolver,
    });
    expect(result).toEqual({ ok: false, error: "too_large" });
  });
});

describe("fetchPublicImage", () => {
  it("reads a JPEG whose bytes match its header", async () => {
    const result = await fetchPublicImage("https://cdn.shop.example.com/a.jpg", {
      fetchFn: (async () => imageResponse(JPEG, { "content-type": "image/jpg" })) as never,
      resolver: splitResolver,
    });
    expect(result).toMatchObject({ ok: true, contentType: "image/jpeg" });
    if (result.ok) expect(result.buffer.equals(JPEG)).toBe(true);
  });

  it("refuses GIF, SVG, HTML and a missing content-type", async () => {
    for (const type of ["image/gif", "image/svg+xml", "text/html", null]) {
      const result = await fetchPublicImage("https://cdn.shop.example.com/a", {
        fetchFn: (async () =>
          imageResponse(JPEG, type ? { "content-type": type } : {})) as never,
        resolver: splitResolver,
      });
      expect(result, String(type)).toEqual({ ok: false, error: "blocked" });
    }
  });

  it("refuses a body that is not what its header claims", async () => {
    const result = await fetchPublicImage("https://cdn.shop.example.com/a.png", {
      fetchFn: (async () => imageResponse(JPEG, { "content-type": "image/png" })) as never,
      resolver: splitResolver,
    });
    expect(result).toEqual({ ok: false, error: "blocked" });

    const png = await fetchPublicImage("https://cdn.shop.example.com/a.png", {
      fetchFn: (async () => imageResponse(PNG, { "content-type": "image/png" })) as never,
      resolver: splitResolver,
    });
    expect(png).toMatchObject({ ok: true, contentType: "image/png" });
  });

  it("caps the body at maxBytes, never above the wishlist cap", async () => {
    const result = await fetchPublicImage("https://cdn.shop.example.com/a.jpg", {
      fetchFn: (async () => imageResponse(JPEG, { "content-type": "image/jpeg" })) as never,
      resolver: splitResolver,
      maxBytes: 4,
    });
    expect(result).toEqual({ ok: false, error: "too_large" });

    const declared = await fetchPublicImage("https://cdn.shop.example.com/a.jpg", {
      fetchFn: (async () =>
        imageResponse(JPEG, { "content-type": "image/jpeg", "content-length": "99999999" })) as never,
      resolver: splitResolver,
      maxBytes: 999_999_999,
    });
    expect(declared).toEqual({ ok: false, error: "too_large" });
  });

  it("refuses a redirect into a private address", async () => {
    const fetchFn = vi.fn(async (url: string) =>
      url.startsWith("https://cdn.shop.example.com")
        ? response({ status: 307, headers: { location: "https://img.internal-pointer.com/x.jpg" } })
        : imageResponse(JPEG, { "content-type": "image/jpeg" }),
    );
    const result = await fetchPublicImage("https://cdn.shop.example.com/a.jpg", {
      fetchFn: fetchFn as never,
      resolver: splitResolver,
    });
    expect(result).toEqual({ ok: false, error: "blocked" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
