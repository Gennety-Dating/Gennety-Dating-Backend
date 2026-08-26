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

  it("appends to the trail instead of overwriting it", () => {
    // The bug this fixes: Premium handing off to referral used to emit only
    // `backTo=premium`, discarding the board that sent the user to Premium —
    // so back worked exactly once and the board became unreachable.
    const params = new URLSearchParams(
      returnParams("premium", { lang: "ru" }, "?backTo=venue-change&backMatch=m1&lang=ru"),
    );
    expect(params.get("backTo")).toBe("premium");
    expect(params.get("backStack")).toBe("venue-change:m1");
  });

  it("collapses a revisit rather than stacking it", () => {
    // Returning to a page already in the trail is a return, not a new level;
    // stacking it would grow the URL forever on a two-screen loop and make
    // back replay a path the user never walked.
    const params = new URLSearchParams(
      returnParams(
        "venue-change",
        { match: "m1", lang: "ru" },
        "?backTo=premium&backStack=venue-change:m1&lang=ru",
      ),
    );
    expect(params.get("backTo")).toBe("venue-change");
    expect(params.get("backStack")).toBeNull();
  });

  it("bounds the trail, dropping the oldest entries", () => {
    let search = "";
    for (let i = 0; i < 40; i++) {
      // Alternating pages would collapse, so walk all four repeatedly.
      const page = (["venue-change", "premium", "ticket-store", "ticket-gate"] as const)[i % 4]!;
      search = `?${returnParams(page, {}, search)}`;
    }
    const stack = new URLSearchParams(search).get("backStack") ?? "";
    expect(stack.split(",").filter(Boolean).length).toBeLessThanOrEqual(5);
  });

  it("drops a match id that could corrupt the encoding", () => {
    const params = new URLSearchParams(
      returnParams("venue-change", { match: "a,b:premium" }),
    );
    expect(params.get("backTo")).toBe("venue-change");
    expect(params.get("backMatch")).toBeNull();
  });
});

describe("the calendar is a returnable page", () => {
  it("round-trips, so the evening-band hand-off to Premium can come back", () => {
    // Without this the calendar's locked-slot → Premium link is a one-way door:
    // the user reads the price, decides against it, and has to close the Mini
    // App and reopen the calendar from chat.
    const search = returnParams("calendar", { match: "m-1", lang: "ru" });
    expect(returnHref(`?${search}`)).toBe("index.html?match=m-1&lang=ru");
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
    expect(returnHref("?backTo=onboarding")).toBeNull();
  });

  it("rebuilds the ticket store, date-ticket gate, and Premium pages", () => {
    // The referral cross-promo link ("invite a friend instead") sends the user
    // here from three more screens; the store and Premium carry no match id.
    expect(returnHref("?backTo=ticket-store&lang=ru")).toBe("tickets.html?lang=ru");
    expect(returnHref("?backTo=ticket-gate&backMatch=m1&lang=ru")).toBe(
      "ticket.html?match=m1&lang=ru",
    );
    expect(returnHref("?backTo=premium&lang=ru")).toBe("premium.html?lang=ru");
  });

  it("is not fooled by a prototype key", () => {
    expect(returnHref("?backTo=constructor")).toBeNull();
    expect(returnHref("?backTo=__proto__")).toBeNull();
  });

  it("hands the page it returns to the rest of the trail", () => {
    // Otherwise the returned-to page believes it was opened cold and hides its
    // own back button — which is exactly how the chain used to die at depth 2.
    expect(returnHref("?backTo=premium&backStack=venue-change:m1&lang=ru")).toBe(
      "premium.html?backTo=venue-change&backMatch=m1&lang=ru",
    );
  });

  it("walks a three-screen chain all the way home", () => {
    // The reported scenario: board → Premium → referral, then back twice.
    const toPremium = returnParams("venue-change", { match: "m1", lang: "ru" }, "?match=m1&lang=ru");
    const toReferral = returnParams("premium", { lang: "ru" }, `?${toPremium}`);

    const back1 = returnHref(`?${toReferral}`);
    expect(back1).toBe("premium.html?backTo=venue-change&backMatch=m1&lang=ru");

    const back2 = returnHref(`?${back1!.split("?")[1]}`);
    expect(back2).toBe("venue-change.html?match=m1&lang=ru");

    // …and the board is the bottom: nothing left to go back to.
    expect(returnHref("?match=m1&lang=ru")).toBeNull();
  });

  it("keeps a deeper trail intact through the middle hops", () => {
    const search = "?backTo=premium&backStack=ticket-gate:m1,venue-change:m2&lang=ru";
    expect(returnHref(search)).toBe(
      "premium.html?backTo=venue-change&backMatch=m2&backStack=ticket-gate%3Am1&lang=ru",
    );
  });

  it("drops a trail entry that is not on the allowlist instead of failing the parse", () => {
    expect(returnHref("?backTo=premium&backStack=evil.example,venue-change:m1&lang=ru")).toBe(
      "premium.html?backTo=venue-change&backMatch=m1&lang=ru",
    );
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
