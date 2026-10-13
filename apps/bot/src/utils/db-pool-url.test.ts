import { describe, expect, it } from "vitest";
import { connectionLimitOf, withConnectionLimit } from "./db-pool-url.js";

const BASE = "postgresql://user:p%40ss@aws-0-eu-west-1.pooler.supabase.com:5432/postgres";

describe("withConnectionLimit", () => {
  it("adds the limit to a URL without a query", () => {
    expect(withConnectionLimit(BASE, 10)).toBe(`${BASE}?connection_limit=10`);
  });

  it("appends to an existing query", () => {
    expect(withConnectionLimit(`${BASE}?sslmode=require`, 10)).toBe(
      `${BASE}?sslmode=require&connection_limit=10`,
    );
  });

  it("keeps an explicit limit from the env", () => {
    const url = `${BASE}?sslmode=require&connection_limit=3`;
    expect(withConnectionLimit(url, 10)).toBe(url);
    expect(withConnectionLimit(`${BASE}?connection_limit=5`, 10)).toBe(
      `${BASE}?connection_limit=5`,
    );
  });

  it("does not mistake a similarly named parameter for the limit", () => {
    expect(withConnectionLimit(`${BASE}?max_connection_limit=3`, 10)).toBe(
      `${BASE}?max_connection_limit=3&connection_limit=10`,
    );
  });

  it("handles a dangling separator", () => {
    expect(withConnectionLimit(`${BASE}?`, 10)).toBe(`${BASE}?connection_limit=10`);
    expect(withConnectionLimit(`${BASE}?a=1&`, 10)).toBe(`${BASE}?a=1&connection_limit=10`);
  });

  it("leaves a missing URL alone", () => {
    expect(withConnectionLimit(undefined, 10)).toBeUndefined();
    expect(withConnectionLimit("", 10)).toBe("");
  });
});

describe("connectionLimitOf", () => {
  it("reads the limit the URL carries", () => {
    expect(connectionLimitOf(`${BASE}?sslmode=require&connection_limit=10`)).toBe("10");
    expect(connectionLimitOf(`${BASE}?connection_limit=3&sslmode=require`)).toBe("3");
    expect(connectionLimitOf(BASE)).toBeNull();
  });
});
