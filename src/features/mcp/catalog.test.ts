import { describe, expect, it } from "vitest";
import { CATALOG } from "./catalog";

const byId = (id: string) => CATALOG.find((c) => c.id === id)!;

describe("MCP catalog", () => {
  it("has unique names that the backend accepts", () => {
    const names = CATALOG.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });
  it("builds https configs for every available entry", () => {
    for (const c of CATALOG.filter((x) => !x.unavailable)) {
      const v = Object.fromEntries((c.fields ?? []).map((f) => [f.key, f.initial ?? "x"]));
      const cfg = c.build(v) as { type: string; url: string };
      expect(["http", "sse"]).toContain(cfg.type);
      expect(cfg.url).toMatch(/^https:\/\//);
    }
  });
  it("normalises self-hosted GitLab hosts and puts keys in headers", () => {
    expect(byId("gitlab").build({ host: "https://git.example.com/" })).toEqual({ type: "http", url: "https://git.example.com/api/v4/mcp" });
    expect(byId("github").build({ token: " t0k " })).toMatchObject({ headers: { Authorization: "Bearer t0k" } });
    expect(byId("bitmovin").build({ key: "k" })).toMatchObject({ headers: { "x-api-key": "k" } });
  });
});
