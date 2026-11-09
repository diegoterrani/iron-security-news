import { Cron } from "croner";
import { loadConfig } from "./config";
import { createPool, pingDb } from "./db";
import { startHealthServer, type HealthState } from "./health";
import { createLogger } from "./logger";
import { createEmbedder } from "./ingest/embeddings";
import { ingestDue, purgeOldItems } from "./ingest/ingest";
import Anthropic from "@anthropic-ai/sdk";
import { parsePriceTable } from "./llm/usage";
import { pollTriageBatches, submitTriageBatch, type TriageDeps } from "./triage/run";
import { runSelectionIfDue } from "./triage/selection";
import { Queue } from "./queue";
import { consumeStoryBuild } from "./story/worker";

/**
 * Fase 0: esqueleto do executor.
 * - valida config, conecta no Postgres, expõe /health interno, envia heartbeat de saída
 * - tick a cada minuto (aqui entram ingest/triage/selection/publish nas próximas fases)
 * - desligamento gracioso em SIGTERM (§13.3)
 */
const config = loadConfig();
const log = createLogger(config.LOG_LEVEL, config.GIT_SHA);
const pool = createPool(config.DATABASE_URL);
// Conexão ociosa derrubada pelo pooler: sem este handler o 'error' do Pool derruba o processo.
pool.on("error", (err) => log.warn({ module: "db", err: err.message }, "idle client error"));

const state: HealthState = {
  version: config.GIT_SHA,
  startedAt: Date.now(),
  dbOk: false,
  lastTickAt: null,
  shuttingDown: false,
};

const server = startHealthServer(config.HEALTH_PORT, state);

async function tick() {
  const dbErr = await pingDb(pool);
  state.dbOk = dbErr === null;
  state.lastTickAt = Date.now();
  if (dbErr !== null) {
    log.error({ module: "scheduler", err: dbErr }, "database unreachable");
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

async function resolveBrandId(): Promise<string | null> {
  try {
    const { rows } = await pool.query<{ id: string }>("select id from brands where slug = $1", [config.BRAND_SLUG]);
    return rows[0]?.id ?? null;
  } catch {
    return null;
  }
}

let brandId: string | null = null;
const embed = createEmbedder(config.CF_ACCOUNT_ID, config.CF_AI_TOKEN);

/** Coleta (§4.2): job próprio, para não atrasar o tick de saúde. */
async function ingest() {
  if (!config.INGEST_ENABLED || !state.dbOk) return;
  brandId ??= await resolveBrandId();
  if (!brandId) {
    log.error({ module: "ingest", brand: config.BRAND_SLUG }, "brand not found");
    return;
  }
  try {
    await ingestDue({ pool, log, brandId, embed, ctx: { nvdApiKey: config.NVD_API_KEY, githubToken: config.GITHUB_TOKEN } });
  } catch (err) {
    log.error({ module: "ingest", err: (err as Error).message }, "ingest cycle failed");
  }
}

const prices = parsePriceTable(config.LLM_PRICE_TABLE);
const anthropic = config.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: config.ANTHROPIC_API_KEY, maxRetries: 3 }) : null;
const aiEnabled = anthropic !== null && config.TRIAGE_ENABLED;

async function triageDeps(): Promise<TriageDeps | null> {
  if (!aiEnabled || !state.dbOk) return null;
  brandId ??= await resolveBrandId();
  if (!brandId) return null;
  return { pool, log, client: anthropic!, brandId, model: config.LLM_MODEL_DEFAULT, prices };
}

/** Triagem em lote a cada 30 min (RN-TRI01) e coleta dos lotes prontos a cada minuto. */
async function triageSubmit() {
  const deps = await triageDeps();
  if (!deps) return;
  try {
    await submitTriageBatch(deps);
  } catch (err) {
    log.error({ module: "triage", err: (err as Error).message }, "triage submit failed");
  }
}

async function triagePoll() {
  const deps = await triageDeps();
  if (!deps) return;
  try {
    await pollTriageBatches(deps);
  } catch (err) {
    log.error({ module: "triage", err: (err as Error).message }, "triage poll failed");
  }
}

async function selection() {
  if (!config.SELECTION_ENABLED) return;
  const deps = await triageDeps();
  if (!deps) return;
  try {
    await runSelectionIfDue(deps);
  } catch (err) {
    log.error({ module: "selection", err: (err as Error).message }, "selection failed");
  }
}

const queue = new Queue(pool);

/** Geração de conteúdo (§9.5): consome a fila story_build alimentada pela seleção. */
async function storyWorker() {
  const deps = await triageDeps();
  if (!deps) return;
  try {
    await consumeStoryBuild(
      { ...deps, fallbackModel: config.LLM_MODEL_FALLBACK, nvdApiKey: config.NVD_API_KEY },
      queue,
    );
  } catch (err) {
    log.error({ module: "story", err: (err as Error).message }, "story worker failed");
  }
}

async function maintenance() {
  if (!state.dbOk) return;
  try {
    const purged = await purgeOldItems(pool);
    log.info({ module: "maintenance", purged }, "raw_items retention");
  } catch (err) {
    log.error({ module: "maintenance", err: (err as Error).message }, "maintenance failed");
  }
}

const jobs = [
  new Cron("* * * * *", { protect: true, timezone: "UTC" }, tick),
  new Cron("30 * * * * *", { protect: true, timezone: "UTC" }, ingest),
  new Cron("17 6 * * *", { protect: true, timezone: "UTC" }, maintenance),
  new Cron("0 5,35 * * * *", { protect: true, timezone: "UTC" }, triageSubmit),
  new Cron("45 * * * * *", { protect: true, timezone: "UTC" }, triagePoll),
  new Cron("50 * * * * *", { protect: true, timezone: "UTC" }, selection),
  new Cron("*/20 * * * * *", { protect: true, timezone: "UTC" }, storyWorker),
];
const heartbeatTimer = setInterval(() => void heartbeat(), config.HEARTBEAT_INTERVAL_SEC * 1000);

await tick();
await heartbeat();
log.info(
  {
    module: "main", port: config.HEALTH_PORT, dryRun: config.PUBLISH_DRY_RUN, db: state.dbOk ? "ok" : "down",
    ingest: config.INGEST_ENABLED, embeddings: embed !== null,
    triage: aiEnabled, selection: aiEnabled && config.SELECTION_ENABLED, model: config.LLM_MODEL_DEFAULT,
  },
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
