import { afterEach, describe, expect, it, vi } from "vitest";

import { DefaultAgentLogger, debugEnabled, resolveLogger } from "../src/logger.js";

afterEach(() => {
  delete process.env["GUARD_AGENT_DEBUG"];
  vi.restoreAllMocks();
});

describe("DefaultAgentLogger", () => {
  it("suppresses debug by default and emits when GUARD_AGENT_DEBUG is truthy", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const logger = new DefaultAgentLogger();

    logger.debug("quiet");
    expect(debugSpy).not.toHaveBeenCalled();

    process.env["GUARD_AGENT_DEBUG"] = "1";
    logger.debug("loud");
    expect(debugSpy).toHaveBeenCalledOnce();
    expect(debugSpy.mock.calls[0]?.[0]).toContain("[guardagent] loud");
  });

  it("treats 0/false/no/off as disabled debug", () => {
    for (const value of ["0", "false", "no", "off"]) {
      process.env["GUARD_AGENT_DEBUG"] = value;
      expect(debugEnabled()).toBe(false);
    }
    process.env["GUARD_AGENT_DEBUG"] = "yes";
    expect(debugEnabled()).toBe(true);
    expect(debugEnabled()).toBe(true);
  });

  it("routes info/warn/error through console with the prefix", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const logger = new DefaultAgentLogger();
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    expect(info.mock.calls[0]?.[0]).toContain("[guardagent] i");
    expect(warn.mock.calls[0]?.[0]).toContain("[guardagent] w");
    expect(error.mock.calls[0]?.[0]).toContain("[guardagent] e");
  });
});

describe("resolveLogger", () => {
  it("returns the default logger for missing input", () => {
    expect(resolveLogger(null)).toBeInstanceOf(DefaultAgentLogger);
    expect(resolveLogger(undefined)).toBeInstanceOf(DefaultAgentLogger);
  });

  it("fills partial loggers with fallback methods and binds the context", () => {
    const warnings: string[] = [];
    const logger = resolveLogger({
      warn: (message: string) => warnings.push(message),
    });
    logger.warn("captured");
    logger.info("fallback");
    expect(warnings).toEqual(["captured"]);
    expect(logger.debug).toBeInstanceOf(Function);
    expect(logger.error).toBeInstanceOf(Function);
  });
});
