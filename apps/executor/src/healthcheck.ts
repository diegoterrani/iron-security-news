// Usado pelo HEALTHCHECK do Docker: sai com 0 se /health responder 200.
export {};
const port = process.env.HEALTH_PORT ?? "8080";
try {
  const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(4000) });
  process.exit(res.ok ? 0 : 1);
} catch {
  process.exit(1);
}
