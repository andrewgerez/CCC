import { describe, expect, it } from "vitest";
import { modelLabel } from "./ModelPicker";

describe("modelLabel", () => {
  it("names aliases and full ids", () => {
    expect(modelLabel("opus[1m]")).toBe("Opus 1M");
    expect(modelLabel("sonnet")).toBe("Sonnet");
    expect(modelLabel("claude-sonnet-4-5-20250929")).toBe("Sonnet 4.5");
    expect(modelLabel("claude-opus-4-1")).toBe("Opus 4.1");
    expect(modelLabel("claude-opus-5[1m]")).toBe("Opus 5 1M");
    expect(modelLabel("my-custom-model")).toBe("my-custom-model");
  });
});
