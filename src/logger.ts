/**
 * Logger seam. Python's guard-agent uses the stdlib `logging` module; this
 * port accepts an injected logger instead so host applications keep control
 * of where telemetry warnings land. The default logger is console-based and
 * quiet on `debug` unless GUARD_AGENT_DEBUG is set.
 */

export interface AgentLogger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

const PREFIX = "[guardagent]";

/** True when GUARD_AGENT_DEBUG is set to a truthy value. */
export function debugEnabled(): boolean {
  const raw = process.env["GUARD_AGENT_DEBUG"];
  if (!raw) return false;
  return !["0", "false", "no", "off"].includes(raw.trim().toLowerCase());
}

/** Console-backed logger used when the caller does not inject one. */
export class DefaultAgentLogger implements AgentLogger {
  debug(message: string): void {
    if (debugEnabled()) console.debug(`${PREFIX} ${message}`);
  }

  info(message: string): void {
    console.info(`${PREFIX} ${message}`);
  }

  warn(message: string): void {
    console.warn(`${PREFIX} ${message}`);
  }

  error(message: string): void {
    console.error(`${PREFIX} ${message}`);
  }
}

/** Coerce a partial logger into a full AgentLogger, filling in the default. */
export function resolveLogger(
  logger: Partial<AgentLogger> | null | undefined,
): AgentLogger {
  const fallback = new DefaultAgentLogger();
  if (!logger) return fallback;
  return {
    debug: typeof logger.debug === "function" ? logger.debug.bind(logger) : fallback.debug.bind(fallback),
    info: typeof logger.info === "function" ? logger.info.bind(logger) : fallback.info.bind(fallback),
    warn: typeof logger.warn === "function" ? logger.warn.bind(logger) : fallback.warn.bind(fallback),
    error: typeof logger.error === "function" ? logger.error.bind(logger) : fallback.error.bind(fallback),
  };
}

/** Format an unknown thrown value for a single log line. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
