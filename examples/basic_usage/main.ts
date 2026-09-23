// Command basic_usage wires guardagent into a guard-core-ts adapter the way
// a production service would: the adapter's agent handler seam builds a
// SecurityEvent per blocked request, the agent buffers and ships it to the
// Guard Core App ingestion API, and shutdown performs a final flush.
//
// Set GUARD_AGENT_API_KEY (required), GUARD_AGENT_ENDPOINT,
// GUARD_AGENT_PROJECT_ID, and GUARD_AGENT_SIGNING_SECRET before running.
// Optional persistence: GUARD_AGENT_REDIS_URL (requires the ioredis peer).
import { GuardAgent } from "guardagent";

const logger = {
  debug: (msg: string) => console.debug(`guard-agent-ts-example ${msg}`),
  info: (msg: string) => console.log(`guard-agent-ts-example ${msg}`),
  warn: (msg: string) => console.warn(`guard-agent-ts-example ${msg}`),
  error: (msg: string) => console.error(`guard-agent-ts-example ${msg}`),
};

const agent = new GuardAgent({
  apiKey: process.env["GUARD_AGENT_API_KEY"] ?? "",
  endpoint: process.env["GUARD_AGENT_ENDPOINT"] ?? "https://api.guard-core.com",
  projectId: process.env["GUARD_AGENT_PROJECT_ID"] ?? undefined,
  payloadSigningSecret: process.env["GUARD_AGENT_SIGNING_SECRET"] ?? undefined,
  guardVersion: "example",
  logger,
  onError: (stage, error, context) => {
    logger.error(`onError stage=${stage}: ${error.message} (${JSON.stringify(context)})`);
  },
});

await agent.start();

// Engine wiring: a guard-core-ts adapter exposes an agent handler where
// the engine hands over each blocked request. This example demonstrates
// the same shape by reporting one event directly.
agent.sendEvent({
  timestamp: new Date(),
  eventType: "suspicious_request",
  ipAddress: "203.0.113.7",
  endpoint: "/api",
  method: "GET",
  actionTaken: "BLOCKED",
  reason: "suspicious pattern",
  metadata: { patternMatched: "xss" },
});

logger.info(`stats: ${JSON.stringify(agent.getStats())}`);
logger.info("idling; press Ctrl+C to flush and exit");

await new Promise<void>((resolve) => {
  process.on("SIGINT", resolve);
  process.on("SIGTERM", resolve);
});

await agent.stop();
logger.info("stopped; final flush complete");
