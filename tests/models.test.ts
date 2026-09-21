import { describe, expect, it } from "vitest";

import { InvalidEventError } from "../src/errors.js";
import {
  normalizeSecurityEvent,
  normalizeSecurityMetric,
  eventToWire,
  metricToWire,
} from "../src/models.js";

describe("normalizeSecurityEvent", () => {
  it("fills pydantic-equivalent defaults", () => {
    const timestamp = new Date("2026-09-20T10:00:00.000Z");
    const event = normalizeSecurityEvent({ eventType: "rate_limited", timestamp });
    expect(event.eventType).toBe("rate_limited");
    expect(event.timestamp).toBe(timestamp);
    expect(event.idempotencyKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(event.ipAddress).toBe("");
    expect(event.actionTaken).toBe("");
    expect(event.reason).toBe("");
    expect(event.country).toBeNull();
    expect(event.statusCode).toBeNull();
    expect(event.metadata).toEqual({});
  });

  it("requires timestamp and eventType like the pydantic model", () => {
    expect(() => normalizeSecurityEvent({ eventType: "rate_limited" })).toThrow(
      InvalidEventError,
    );
    expect(() => normalizeSecurityEvent({ timestamp: new Date() })).toThrow(InvalidEventError);
  });

  it("accepts snake_case wire-style input (Python field names)", () => {
    const event = normalizeSecurityEvent({
      event_type: "penetration_attempt",
      idempotency_key: "123e4567-e89b-12d3-a456-426614174000",
      timestamp: "2026-09-20T10:00:00.000Z",
      ip_address: "198.51.100.9",
      action_taken: "blocked",
      status_code: 403,
      metadata: { rule: "sqli" },
    });
    expect(event.eventType).toBe("penetration_attempt");
    expect(event.idempotencyKey).toBe("123e4567-e89b-12d3-a456-426614174000");
    expect(event.timestamp.toISOString()).toBe("2026-09-20T10:00:00.000Z");
    expect(event.ipAddress).toBe("198.51.100.9");
    expect(event.statusCode).toBe(403);
  });

  it("returns an existing SecurityEvent instance unchanged", () => {
    const original = normalizeSecurityEvent({
      eventType: "ip_banned",
      timestamp: new Date(),
    });
    expect(normalizeSecurityEvent(original)).toBe(original);
  });

  it("rejects missing eventType, invalid timestamps, and bad UUIDs", () => {
    expect(() => normalizeSecurityEvent({})).toThrow(InvalidEventError);
    expect(() =>
      normalizeSecurityEvent({ eventType: "x", timestamp: "not-a-date" }),
    ).toThrow(InvalidEventError);
    expect(() =>
      normalizeSecurityEvent({ eventType: "x", idempotencyKey: "nope" }),
    ).toThrow(InvalidEventError);
    expect(() => normalizeSecurityEvent("a string")).toThrow(InvalidEventError);
    expect(() =>
      normalizeSecurityEvent({ eventType: "x", statusCode: 1.5 }),
    ).toThrow(InvalidEventError);
  });
});

describe("normalizeSecurityMetric", () => {
  it("validates metric_type against the server Literal", () => {
    const metric = normalizeSecurityMetric({
      metricType: "request_count",
      value: 12,
      tags: { route: "/login" },
      timestamp: new Date(),
    });
    expect(metric.metricType).toBe("request_count");
    expect(metric.value).toBe(12);
    expect(metric.tags).toEqual({ route: "/login" });
    expect(() =>
      normalizeSecurityMetric({ metricType: "not_a_metric", value: 1 }),
    ).toThrow(InvalidEventError);
    expect(() => normalizeSecurityMetric({ metricType: "error_rate" })).toThrow(
      InvalidEventError,
    );
  });

  it("coerces numeric string values like pydantic", () => {
    const metric = normalizeSecurityMetric({ metricType: "error_rate", value: "1.5", timestamp: new Date() });
    expect(metric.value).toBe(1.5);
  });
});

describe("wire conversion", () => {
  it("emits snake_case payloads matching the Python model_dump()", () => {
    const event = normalizeSecurityEvent({
      eventType: "rate_limited",
      timestamp: new Date("2026-09-20T10:00:00.000Z"),
      ipAddress: "203.0.113.7",
      statusCode: 429,
      metadata: { window: 60 },
    });
    const wire = eventToWire(event);
    expect(Object.keys(wire).sort()).toEqual(
      [
        "action_taken",
        "country",
        "decorator_type",
        "endpoint",
        "event_type",
        "handler_name",
        "idempotency_key",
        "ip_address",
        "metadata",
        "method",
        "pattern_matched",
        "reason",
        "response_time",
        "rule_type",
        "status_code",
        "timestamp",
        "user_agent",
      ].sort(),
    );
    expect(wire["event_type"]).toBe("rate_limited");
    expect(wire["ip_address"]).toBe("203.0.113.7");
    expect(wire["status_code"]).toBe(429);
    expect(typeof wire["timestamp"]).toBe("string");
  });

  it("emits snake_case metric payloads", () => {
    const metric = normalizeSecurityMetric({ metricType: "block_rate", value: 3, timestamp: new Date() });
    const wire = metricToWire(metric);
    expect(Object.keys(wire).sort()).toEqual(
      ["endpoint", "metric_type", "tags", "timestamp", "value"].sort(),
    );
    expect(wire["metric_type"]).toBe("block_rate");
  });
});
