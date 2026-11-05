import { describe, expect, it } from "vitest";
import { buildConfig, parsePairs, splitCommand } from "./McpView";

describe("mcp form helpers", () => {
  it("splits commands honouring quotes", () => {
    expect(splitCommand(`npx -y "@scope/server x" '/tmp/a b'`)).toEqual(["npx", "-y", "@scope/server x", "/tmp/a b"]);
  });
  it("parses KEY=value and Header: value lines, skipping comments", () => {
    expect(parsePairs("A=1\n# no\n\nAuthorization: Bearer x=y\nbad")).toEqual({ A: "1", Authorization: "Bearer x=y" });
  });
  it("builds stdio and http configs", () => {
    expect(buildConfig("stdio", "npx -y srv", "TOKEN=t")).toEqual({ type: "stdio", command: "npx", args: ["-y", "srv"], env: { TOKEN: "t" } });
    expect(buildConfig("http", " https://x/mcp ", "")).toEqual({ type: "http", url: "https://x/mcp" });
  });
});
