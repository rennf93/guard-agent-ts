/**
 * HMAC payload signing, mirroring guard_agent/signing.py.
 *
 * When `payloadSigningSecret` is configured the transport sends
 * `X-Payload-Signature: v1=<hex>`, where <hex> is the HMAC-SHA256 of the
 * exact request body bytes (after gzip, when compression applies). The server
 * verifies it in guard-core-api at
 * guard_core_api/api/routers/telemetry_router.py:110-126 against
 * INGEST_PAYLOAD_SIGNING_SECRET.
 */
import { createHmac } from "node:crypto";

const VERSION_PREFIX = "v1=";

/**
 * Sign a request body. Returns null when no secret is configured, matching
 * the Python agent (no header is sent in that case).
 */
export function signPayload(
  body: Uint8Array,
  secret: string | null | undefined,
): string | null {
  if (!secret) return null;
  const digest = createHmac("sha256", secret).update(body).digest("hex");
  return `${VERSION_PREFIX}${digest}`;
}
