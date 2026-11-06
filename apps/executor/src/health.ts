import http from "node:http";

export interface HealthState {
  version: string;
  startedAt: number;
  dbOk: boolean;
  lastTickAt: number | null;
  shuttingDown: boolean;
}

export function healthPayload(state: HealthState, now = Date.now()) {
  const tickStale = state.lastTickAt !== null && now - state.lastTickAt > 3 * 60_000;
  const healthy = state.dbOk && !tickStale && !state.shuttingDown;
  return {
    status: healthy ? "ok" : "degraded",
    version: state.version,
    uptimeSec: Math.round((now - state.startedAt) / 1000),
    db: state.dbOk ? "ok" : "down",
    lastTickAt: state.lastTickAt ? new Date(state.lastTickAt).toISOString() : null,
  };
}

/** Servidor de health só na rede interna do Docker (sem porta publicada no host). */
export function startHealthServer(port: number, state: HealthState) {
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      const body = healthPayload(state);
      res.writeHead(body.status === "ok" ? 200 : 503, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(port, "0.0.0.0");
  return server;
}
