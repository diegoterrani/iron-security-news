import { Cron } from "croner";
import { loadConfig } from "./config";
import { createPool, pingDb } from "./db";
import { startHealthServer, type HealthState } from "./health";
import { createLogger } from "./logger";

/**
 * Fase 0: esqueleto do executor.
 * - valida config, conecta no Postgres, expõe /health interno, envia heartbeat de saída
 * - tick a cada minuto (aqui entram ingest/triage/selection/publish nas próximas fases)
 * - desligamento gracioso em SIGTERM (§13.3)
 */
const config = loadConfig();
const log = createLogger(config.LOG_LEVEL, config.GIT_SHA);
const pool = createPool(config.DATABASE_URL);

const state: HealthState = {
  version: config.GIT_SHA,
  startedAt: Date.now(),
  dbOk: false,
  lastTickAt: null,
  shuttingDown: false,
};

const server = startHealthServer(config.HEALTH_PORT, state);

async function tick() {
  state.dbOk = await pingDb(pool);
  state.lastTickAt = Date.now();
  if (!state.dbOk) {
    log.error({ module: "scheduler" }, "database unreachable");
    return;
  }
  log.debug({ module: "scheduler" }, "tick");
  // TODO(Fase 1): ingest-due, triage-batch, selection, publish-due, maintenance.
}

async function heartbeat() {
  if (!config.HEARTBEAT_URL || !state.dbOk) return;
  try {
    await fetch(config.HEARTBEAT_URL, { method: "POST", signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    log.warn({ module: "heartbeat", err: (err as Error).message }, "heartbeat failed");
  }
}

const jobs = [new Cron("* * * * *", { protect: true, timezone: "UTC" }, tick)];
const heartbeatTimer = setInterval(() => void heartbeat(), config.HEARTBEAT_INTERVAL_SEC * 1000);

await tick();
await heartbeat();
log.info(
  { module: "main", port: config.HEALTH_PORT, dryRun: config.PUBLISH_DRY_RUN, db: state.dbOk ? "ok" : "down" },
  "executor started",
);

async function shutdown(signal: string) {
  if (state.shuttingDown) return;
  state.shuttingDown = true;
  log.info({ module: "main", signal }, "shutting down");
  clearInterval(heartbeatTimer);
  for (const job of jobs) job.stop();
  // Jobs em andamento terminam aqui (até 60 s); mensagens não confirmadas voltam pela visibilidade da fila.
  const deadline = Date.now() + 60_000;
  while (jobs.some((j) => j.isBusy()) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
  }
  server.close();
  await pool.end().catch(() => undefined);
  log.info({ module: "main" }, "bye");
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (err) => log.error({ module: "main", err }, "unhandled rejection"));
