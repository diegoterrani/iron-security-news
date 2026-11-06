import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { healthPayload } from "../src/health";
import { backoffSeconds } from "../src/queue";

const base = { DATABASE_URL: "postgresql://u:p@localhost:5432/postgres" };

describe("loadConfig", () => {
  it("exige DATABASE_URL postgres", () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ DATABASE_URL: "https://x.y" })).toThrow(/postgres/);
  });

  it("dry-run ligado fora de produção e desligado em produção, salvo override", () => {
    expect(loadConfig({ ...base, NODE_ENV: "development" }).PUBLISH_DRY_RUN).toBe(true);
    expect(loadConfig({ ...base, NODE_ENV: "production" }).PUBLISH_DRY_RUN).toBe(false);
    expect(loadConfig({ ...base, NODE_ENV: "production", PUBLISH_DRY_RUN: "1" }).PUBLISH_DRY_RUN).toBe(true);
  });
});

describe("backoffSeconds", () => {
  it("cresce exponencialmente com teto de 30 min", () => {
    expect([1, 2, 3, 4, 5].map(backoffSeconds)).toEqual([30, 60, 120, 240, 480]);
    expect(backoffSeconds(20)).toBe(1800);
  });
});

describe("healthPayload", () => {
  const state = { version: "abc", startedAt: 0, dbOk: true, lastTickAt: 60_000, shuttingDown: false };
  it("ok com DB e tick recente", () => {
    expect(healthPayload(state, 120_000).status).toBe("ok");
  });
  it("degraded com DB fora, tick parado ou desligando", () => {
    expect(healthPayload({ ...state, dbOk: false }, 120_000).status).toBe("degraded");
    expect(healthPayload(state, 60_000 + 4 * 60_000).status).toBe("degraded");
    expect(healthPayload({ ...state, shuttingDown: true }, 120_000).status).toBe("degraded");
  });
});
