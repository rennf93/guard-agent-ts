/**
 * Install ID resolution, mirroring guard_agent/install_id.py.
 *
 * The install ID is a stable per-installation UUID sent as
 * `X-Agent-Install-Id` and used server-side for install tracking
 * (guard-core-api guard_core_api/api/routers/telemetry_router.py:194). It is
 * cached on disk at ~/.guard-agent/install-id; every filesystem failure falls
 * back to a fresh in-memory UUID rather than raising, because telemetry must
 * never break the host application.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { AgentLogger } from "./logger.js";

/** Default on-disk location of the install ID. */
export function defaultInstallIdPath(): string {
  return join(homedir(), ".guard-agent", "install-id");
}

function readInstallId(path: string, logger: AgentLogger): string | null {
  try {
    const value = readFileSync(path, "utf8").trim();
    return value.length > 0 ? value : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.warn(`install_id.read_failed path=${path}: ${String(error)}`);
    }
    return null;
  }
}

function writeInstallId(path: string, installId: string, logger: AgentLogger): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, installId, "utf8");
  } catch (error) {
    logger.warn(`install_id.write_failed path=${path}: ${String(error)}`);
  }
}

/**
 * Resolve the install ID: an explicit override wins, then the cached value,
 * otherwise a new UUID is generated and cached.
 */
export function resolveInstallId(options: {
  statePath?: string | null;
  override?: string | null;
  logger: AgentLogger;
}): string {
  const { logger } = options;
  const override = options.override;
  if (override) return override;

  const statePath = options.statePath ?? defaultInstallIdPath();
  const existing = readInstallId(statePath, logger);
  if (existing) return existing;

  const created = randomUUID();
  writeInstallId(statePath, created, logger);
  return created;
}
