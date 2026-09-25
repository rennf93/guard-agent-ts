import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AGENT_VERSION } from "../src/version.js";

describe("AGENT_VERSION", () => {
  it("is derived from the package.json version, not a hardcoded literal", () => {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf-8"),
    ) as { version: string };
    expect(AGENT_VERSION).toBe(pkg.version);
  });

  it("is a plain semver string", () => {
    expect(AGENT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
