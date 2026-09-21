import { describe, expect, it } from "vitest";

import { resolveAgentConfig, validateAgentConfig } from "../src/config.js";
import { ConfigError } from "../src/errors.js";
import { collectingLogger } from "./helpers/test-utils.js";

describe("resolveAgentConfig", () => {
  it("fills Python-mirrored defaults", () => {
    const config = resolveAgentConfig({ apiKey: "test-api-key-1234" });
    expect(config.endpoint).toBe("https://api.guard-core.com");
    expect(config.projectId).toBeNull();
    expect(config.bufferSize).toBe(100);
    expect(config.flushInterval).toBe(30);
    expect(config.statusInterval).toBe(300);
    expect(config.highWatermarkRatio).toBe(0.8);
    expect(config.maxConcurrentFlushes).toBe(1);
    expect(config.bufferOverflowPolicy).toBe("drop");
    expect(config.enableMetrics).toBe(true);
    expect(config.enableEvents).toBe(true);
    expect(config.retryAttempts).toBe(3);
    expect(config.timeout).toBe(30);
    expect(config.backoffFactor).toBe(1.0);
    expect(config.sensitiveHeaders).toEqual([
      "authorization",
      "proxy-authorization",
      "cookie",
      "x-api-key",
    ]);
    expect(config.compressionEnabled).toBe(true);
    expect(config.compressionThreshold).toBe(1024);
    expect(config.payloadSigningSecret).toBeNull();
    expect(config.redis).toBeNull();
  });

  it("strips trailing slashes from the endpoint", () => {
    const config = resolveAgentConfig({
      apiKey: "test-api-key-1234",
      endpoint: "https://api.example.com/",
    });
    expect(config.endpoint).toBe("https://api.example.com");
  });

  it("strips a legacy /api/v1 suffix exactly once, then stays quiet", () => {
    const logger1 = collectingLogger();
    resolveAgentConfig({
      apiKey: "test-api-key-1234",
      endpoint: "https://api.example.com/api/v1",
      logger: logger1,
    });
    // The very first bad-endpoint resolution warns (module-level one-time
    // flag, mirroring Python); every later resolution must stay quiet.
    const logger2 = collectingLogger();
    const config = resolveAgentConfig({
      apiKey: "test-api-key-1234",
      endpoint: "https://other.example.com/api/v1",
      logger: logger2,
    });
    expect(config.endpoint).toBe("https://other.example.com");
    expect(logger2.warnings()).toEqual([]);
  });

  it("rejects empty, malformed, and non-http endpoints", () => {
    expect(() => resolveAgentConfig({ apiKey: "test-api-key-1234", endpoint: "" })).toThrow(
      ConfigError,
    );
    expect(() =>
      resolveAgentConfig({ apiKey: "test-api-key-1234", endpoint: "not a url" }),
    ).toThrow(ConfigError);
    expect(() =>
      resolveAgentConfig({ apiKey: "test-api-key-1234", endpoint: "ftp://api.example.com" }),
    ).toThrow(ConfigError);
  });

  it("raises ConfigError listing every validation failure", () => {
    try {
      resolveAgentConfig({ apiKey: "short" });
      expect.unreachable("expected ConfigError");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const message = (error as ConfigError).message;
      expect(message).toContain("Invalid agent configuration");
      expect(message).toContain("apiKey must be at least 10 characters long");
    }
  });

  it("validates buffer, interval, ratio, and redis options", () => {
    const base = { apiKey: "test-api-key-1234" };
    expect(() => resolveAgentConfig({ ...base, bufferSize: 0 })).toThrow(
      /bufferSize must be greater than 0/,
    );
    expect(() => resolveAgentConfig({ ...base, flushInterval: 0 })).toThrow(
      /flushInterval must be greater than 0/,
    );
    expect(() => resolveAgentConfig({ ...base, retryAttempts: -1 })).toThrow(
      /retryAttempts cannot be negative/,
    );
    expect(() => resolveAgentConfig({ ...base, statusInterval: 30 })).toThrow(
      /statusInterval must be at least 60 seconds/,
    );
    expect(() => resolveAgentConfig({ ...base, highWatermarkRatio: 1.5 })).toThrow(
      /highWatermarkRatio must be in the range \(0, 1\]/,
    );
    expect(() =>
      resolveAgentConfig({
        ...base,
        redis: { url: "ftp://localhost:6379", keyPrefix: "x" },
      }),
    ).toThrow(/redis.url must be a redis:\/\/ or rediss:\/\/ URL/);
    expect(validateAgentConfig(resolveAgentConfig(base))).toEqual([]);
  });

  it("normalizes redis options with the default key prefix", () => {
    const config = resolveAgentConfig({
      apiKey: "test-api-key-1234",
      redis: { url: "redis://localhost:6379" },
    });
    expect(config.redis).toMatchObject({
      url: "redis://localhost:6379",
      keyPrefix: "guard:agent",
      commandTimeoutMs: 5000,
    });
  });
});
