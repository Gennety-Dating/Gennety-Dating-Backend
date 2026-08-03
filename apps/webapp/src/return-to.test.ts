import { describe, expect, it, vi } from "vitest";
import { returnHref, returnParams, wireReturnBackButton } from "./return-to.js";

describe("returnParams", () => {
  it("carries the page, the match and the language", () => {
    const params = new URLSearchParams(
      returnParams("venue-change", { match: "m1", lang: "ru" }),
    );
    expect(params.get("backTo")).toBe("venue-change");
    expect(params.get("backMatch")).toBe("m1");
    expect(params.get("lang")).toBe("ru");
  });

  it("omits what it does not have rather than emitting empty values", () => {
    expect(returnParams("venue-change", {})).toBe("backTo=venue-change");
  });
});

describe("returnHref", () => {
  it("rebuilds the board URL, with the match the board needs to reopen", () => {
    // venue-change.html reads `?match=`; a page reached from a chat web_app
    // button has no start_param to fall back on, so it must be carried.
    expect(returnHref("?backTo=venue-change&backMatch=m1&lang=ru")).toBe(
      "venue-change.html?match=m1&lang=ru",
    );
  });

  it("returns null when the page was opened cold — there is nothing to go back to", () => {
    expect(returnHref("")).toBeNull();
    expect(returnHref("?lang=ru")).toBeNull();
  });

  it("refuses a page that is not on the allowlist", () => {
    // The target arrives in a user-editable query string; anything else would
    // be an open redirect inside the WebView.
    expect(returnHref("?backTo=https://evil.example/x")).toBeNull();
    expect(returnHref("?backTo=../../etc/passwd")).toBeNull();
    expect(returnHref("?backTo=premium")).toBeNull();
  });

  it("is not fooled by a prototype key", () => {
    expect(returnHref("?backTo=constructor")).toBeNull();
    expect(returnHref("?backTo=__proto__")).toBeNull();
  });
});

describe("wireReturnBackButton", () => {
  function backButton() {
    return { show: vi.fn(), hide: vi.fn(), onClick: vi.fn() };
  }

  it("shows the button and navigates to the board when tapped", () => {
    const bb = backButton();
    const navigate = vi.fn();

    const wired = wireReturnBackButton(bb, "?backTo=venue-change&backMatch=m1&lang=ru", navigate);

    expect(wired).toBe(true);
    expect(bb.show).toHaveBeenCalled();
    bb.onClick.mock.calls[0]![0]!();
    expect(navigate).toHaveBeenCalledWith("venue-change.html?match=m1&lang=ru");
  });

  it("hides a button the previous page left showing, rather than leaving it dead", () => {
    // The BackButton belongs to the Mini App session, not the page: the board
    // shows it on a venue detail page and that survives the navigation here.
    const bb = backButton();

    const wired = wireReturnBackButton(bb, "", vi.fn());

    expect(wired).toBe(false);
    expect(bb.hide).toHaveBeenCalled();
    expect(bb.onClick).not.toHaveBeenCalled();
  });

  it("degrades quietly on a client with no BackButton", () => {
    expect(wireReturnBackButton(undefined, "?backTo=venue-change&backMatch=m1")).toBe(false);
  });
});
