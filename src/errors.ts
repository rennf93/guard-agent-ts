/**
 * Typed errors for guardagent. Mirrors guard_agent/exceptions.py plus the
 * two utils-level exceptions (RateLimitedError, SerializationError).
 *
 * Failure policy mirrored from Python: nothing on the sendEvent/sendMetric/
 * flushBuffer event path ever throws into the host application. The only
 * typed errors callers can observe are BufferFullError (overflow policy
 * "raise") and ConfigError at construction time.
 */

/** Base class for all guardagent errors. */
export class GuardAgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuardAgentError";
  }
}

/** Thrown when AgentConfig fails validation. Raises at construction time. */
export class ConfigError extends GuardAgentError {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * Thrown when an EventBuffer is full and the configured overflow policy is
 * "raise". Under the default "drop" policy and the "block" policy this is
 * never thrown.
 */
export class BufferFullError extends GuardAgentError {
  constructor(message: string) {
    super(message);
    this.name = "BufferFullError";
  }
}

/** Thrown when an event/metric cannot be normalized into the wire model. */
export class InvalidEventError extends GuardAgentError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidEventError";
  }
}

/** Raised when an object cannot be serialized to JSON for transport. */
export class SerializationError extends GuardAgentError {
  constructor(message: string) {
    super(message);
    this.name = "SerializationError";
  }
}

/**
 * Raised on HTTP 429. Carries the server-supplied Retry-After in seconds
 * (default 60 when the header is absent or unparseable).
 */
export class RateLimitedError extends GuardAgentError {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number, message?: string) {
    super(
      message ??
        `Rate limited by server, retry after ${retryAfterSeconds.toFixed(1)}s`,
    );
    this.name = "RateLimitedError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Raised on a non-retryable 4xx (400/404/422). The batch must be dropped,
 * not retried. 401/403 intentionally do NOT use this class: the Python
 * agent classifies auth failures as generic errors, which retry until
 * attempts are exhausted and then requeue; this port mirrors that.
 */
export class PermanentClientError extends GuardAgentError {
  readonly statusCode: number;
  readonly detail: string;

  constructor(statusCode: number, detail = "") {
    let message = `Permanent client error ${statusCode}`;
    if (detail) message = `${message}: ${detail}`;
    super(message);
    this.name = "PermanentClientError";
    this.statusCode = statusCode;
    this.detail = detail;
  }
}

/** Raised on HTTP 413. The caller splits the batch or drops a singleton. */
export class PayloadTooLargeError extends PermanentClientError {
  constructor(detail = "") {
    super(413, detail);
    this.name = "PayloadTooLargeError";
  }
}
