/**
 * Per-user preview (decision 2026-11-03): a person on SCREENSHOT_LIBRARY_USER_IDS
 * or MEMORY_IDEAS_USER_IDS gets the feature with its flag off; everyone else
 * keeps the flag-off behaviour. The real env object is used and restored.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { env } from "../config.js";
import { appConfigRouter } from "../public/routes/app-config.js";
import { signAccessToken } from "../public/jwt.js";
import { memoryIdeasOn, memoryIdeasUsers, screenshotLibraryOn, screenshotLibraryUsers } from "./feature-preview.js";

const LISTED = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

type Mutable = Record<string, unknown>;
const saved: Mutable = {};
const keys = ["SCREENSHOT_LIBRARY_ENABLED", "MEMORY_IDEAS_ENABLED", "SCREENSHOT_LIBRARY_USER_IDS", "MEMORY_IDEAS_USER_IDS", "JWT_SECRET"];

beforeEach(() => {
  for (const k of keys) saved[k] = (env as Mutable)[k];
  Object.assign(env as Mutable, {
    SCREENSHOT_LIBRARY_ENABLED: false,
    MEMORY_IDEAS_ENABLED: false,
    SCREENSHOT_LIBRARY_USER_IDS: [LISTED],
    MEMORY_IDEAS_USER_IDS: [LISTED],
    JWT_SECRET: "x".repeat(64),
  });
});
afterEach(() => {
  Object.assign(env as Mutable, saved);
});

describe("the helper", () => {
  it("on for a listed person, off for anyone else and for no one", () => {
    expect(screenshotLibraryOn(LISTED)).toBe(true);
    expect(memoryIdeasOn(LISTED.toUpperCase())).toBe(true);
    expect(screenshotLibraryOn(OTHER)).toBe(false);
    expect(memoryIdeasOn(undefined)).toBe(false);
  });

  it("the global flag still turns it on for everyone", () => {
    (env as Mutable).MEMORY_IDEAS_ENABLED = true;
    expect(memoryIdeasOn(OTHER)).toBe(true);
    expect(memoryIdeasUsers()).toBeNull();
  });

  it("a job acts for the list, or for nobody with an empty one", () => {
    expect(screenshotLibraryUsers()).toEqual([LISTED]);
    (env as Mutable).SCREENSHOT_LIBRARY_USER_IDS = [];
    expect(screenshotLibraryUsers()).toEqual([]);
  });
});

describe("GET /v1/app/config", () => {
  const app = () => express().use("/v1/app", appConfigRouter);

  it("reports both features on for a listed person's token", async () => {
    const res = await request(app()).get("/v1/app/config").set("Authorization", `Bearer ${signAccessToken(LISTED)}`);
    expect(res.body.features).toMatchObject({ screenshotLibrary: true, memoryIdeas: true });
    expect(String(res.headers.vary)).toMatch(/Authorization/);
  });

  it("reports them off for another person, and without a token", async () => {
    const other = await request(app()).get("/v1/app/config").set("Authorization", `Bearer ${signAccessToken(OTHER)}`);
    expect(other.body.features).toMatchObject({ screenshotLibrary: false, memoryIdeas: false });
    const anonymous = await request(app()).get("/v1/app/config");
    expect(anonymous.status).toBe(200);
    expect(anonymous.body.features).toMatchObject({ screenshotLibrary: false, memoryIdeas: false });
  });

  it("an invalid token is still served, as anonymous", async () => {
    const res = await request(app()).get("/v1/app/config").set("Authorization", "Bearer nope");
    expect(res.status).toBe(200);
    expect(res.body.features.memoryIdeas).toBe(false);
  });
});
