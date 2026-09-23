# basic_usage

Minimal guardagent wiring: construct the agent from the environment,
start it, build a `SecurityEvent` the same way a guard-core-ts adapter's
agent handler would, and perform a final flush on SIGINT/SIGTERM.

## Run

```bash
# from the repo root: pnpm install && pnpm build (the example imports the
# built dist through Node's package self-reference)

export GUARD_AGENT_API_KEY="your-api-key"          # required, min 10 chars
export GUARD_AGENT_ENDPOINT="https://api.guard-core.com"
export GUARD_AGENT_PROJECT_ID="your-project-id"    # optional
export GUARD_AGENT_SIGNING_SECRET="your-secret"    # optional, enables HMAC signing
export GUARD_AGENT_REDIS_URL="redis://localhost:6379/0"  # optional, needs the ioredis peer

npx tsx examples/basic_usage/main.ts
```

The example stays a wiring demonstration: it validates the config, starts
the flush and status loops, reports one `suspicious_request` event, and
performs a final flush on SIGINT/SIGTERM. For a full guarded HTTP
service, see the guard-core-ts adapters (express, fastify, hono, nestjs),
which combine the engine, an adapter, and this same agent wiring.

## Notes

- The direct agent API (`sendEvent`, `sendMetric`, `getStatus`,
  `getStats`) is for custom events or standalone deployments; most
  guard-core-ts deployments only need the adapter's agent handler seam.
- `sendEvent` accepts camelCase or snake_case fields and defaults
  `timestamp` to now and `idempotencyKey` to a fresh UUID.
- Without `GUARD_AGENT_REDIS_URL` the agent runs on in-memory state only;
  with it (and `ioredis` installed), every buffered item persists before
  the send attempt for crash recovery.
