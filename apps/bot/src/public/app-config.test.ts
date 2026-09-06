import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { appConfigRouter } from "./routes/app-config.js";
import { ticketProducts } from "../services/appstore.js";

function buildApp() {
  const app = express();
  app.use("/v1/app", appConfigRouter);
  return app;
}

describe("GET /v1/app/config", () => {
  it("serves the pre-auth bootstrap payload without authentication", async () => {
    const res = await request(buildApp()).get("/v1/app/config");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      features: {
        phoneAuth: expect.any(Boolean),
        tickets: expect.any(Boolean),
        coordination: expect.any(Boolean),
      },
    });
    // Kill switch defaults to null (no forced update) unless the env is set.
    expect(
      res.body.minSupportedIosVersion === null ||
        typeof res.body.minSupportedIosVersion === "string",
    ).toBe(true);
    expect(new Date(res.body.serverNow).getTime()).not.toBeNaN();
  });

  it("advertises the launched markets so the client can gate the city step", async () => {
    const res = await request(buildApp()).get("/v1/app/config");
    expect(res.body.supportedCities).toEqual([
      {
        cityKey: "ua:kyiv",
        city: "Kyiv",
        countryCode: "UA",
        latitude: 50.4501,
        longitude: 30.5234,
      },
    ]);
  });

  it("does not leak server-internal config keys", async () => {
    const res = await request(buildApp()).get("/v1/app/config");
    expect(Object.keys(res.body).sort()).toEqual([
      "cityCatalog",
      "features",
      "minSupportedIosVersion",
      "serverNow",
      "supportedCities",
      "ticketProducts",
    ]);
  });

  it("publishes the waitlist tier separately from the launched one", async () => {
    const res = await request(buildApp()).get("/v1/app/config");
    // A native client that only knows `supportedCities` must keep seeing
    // exactly the launched set — a waitlist city leaking in there would be a
    // dating city it then tries (and fails) to save.
    expect(res.body.supportedCities.map((c: { cityKey: string }) => c.cityKey)).toEqual([
      "ua:kyiv",
    ]);
    expect(res.body.cityCatalog[0]).toMatchObject({
      cityKey: "ua:kyiv",
      status: "active",
    });
    expect(
      res.body.cityCatalog.find((c: { cityKey: string }) => c.cityKey === "de:berlin"),
    ).toMatchObject({ city: "Berlin", countryCode: "DE", status: "waitlist" });
  });

  // The app must load exactly the consumables this server will credit: a
  // StoreKit id that only exists in the client is a purchase that takes money
  // and then 422s on report.
  it("serves the StoreKit consumable ladder in ladder order", () => {
    const products = ticketProducts();
    expect(products).toEqual([
      { productId: "ticket_1", tickets: 1 },
      { productId: "ticket_3", tickets: 3 },
      { productId: "ticket_6", tickets: 6 },
    ]);
  });
});
