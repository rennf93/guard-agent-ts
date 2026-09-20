import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { defaultInstallIdPath, resolveInstallId } from "../src/install-id.js";
import { collectingLogger } from "./helpers/test-utils.js";

const tempDirs: string[] = [];

function tempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "guardagent-install-"));
  tempDirs.push(dir);
  return join(dir, "install-id");
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveInstallId", () => {
  it("returns the override without touching the filesystem", () => {
    const logger = collectingLogger();
    expect(resolveInstallId({ override: "custom-id", statePath: "/nonexistent/x", logger })).toBe(
      "custom-id",
    );
  });

  it("creates and caches a UUID at the state path", () => {
    const statePath = tempPath();
    const logger = collectingLogger();
    const first = resolveInstallId({ statePath, logger });
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    // Second resolution reuses the cached value.
    expect(resolveInstallId({ statePath, logger })).toBe(first);
  });

  it("reads an existing install id file", () => {
    const statePath = tempPath();
    writeFileSync(statePath, "  existing-id\n", "utf8");
    expect(resolveInstallId({ statePath, logger: collectingLogger() })).toBe("existing-id");
  });

  it("falls back to a fresh UUID when the state path is unwritable", () => {
    const statePath = tempPath();
    mkdirSync(join(statePath, "blocked"), { recursive: true }); // a directory where the file should be
    const logger = collectingLogger();
    const id = resolveInstallId({ statePath: join(statePath, "blocked"), logger });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(logger.warnings().length).toBeGreaterThanOrEqual(1);
  });

  it("defaults the state path under the home directory", () => {
    expect(defaultInstallIdPath()).toContain(".guard-agent");
  });
});
