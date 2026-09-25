/**
 * Agent version, reported to the ingestion API as `agent_version` and used in
 * the `User-Agent` header. Mirrors guard_agent/_version.py.
 *
 * Derived from package.json (the single source of truth, bumped via
 * `make bump-version VERSION=x.y.z`) so the wire stamp cannot drift from the
 * release version; tsup/esbuild and vitest inline the value.
 */
import pkg from "../package.json";

export const AGENT_VERSION: string = pkg.version;
