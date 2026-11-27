#!/usr/bin/env node
/**
 * Agenda 1 vídeo MP4 no PERFIL do LinkedIn pela fila de Campanhas do News (sem navegador).
 * Usado pelo agendamento diário do Plantão Cyber. Só Node 22 (fetch, crypto, fs): nenhuma dependência.
 *
 * Uso:
 *   NEWS_AUTOMATION_URL=https://news.iron-security.com \
 *   AUTOMATION_TOKEN=... AUTOMATION_HMAC_SECRET=... \
 *   node agendar-linkedin-video.mjs --video ep.mp4 --legenda legenda.txt \
 *     --quando 2026-11-28T18:00:00-03:00 --chave plantao-2026-11-28-linkedin [--campanha "Plantão Cyber"] \
 *     [--comentario comentario.txt]
 *
 * Saída (stdout, JSON): { id, status, scheduled_for, duplicate }. Erros vão para stderr com código != 0.
 * Nunca imprime token, segredo, URL assinada nem a legenda.
 */
import { createHmac } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const MAX_VIDEO_BYTES = 500 * 1024 * 1024;

export function sign(secret, ts, method, path, body) {
  return createHmac("sha256", secret).update(`${ts}.${method.toUpperCase()}.${path}.${body}`).digest("hex");
}

export function parseArgs(argv) {
  const out = { campanha: "Plantão Cyber" };
  const keys = { "--video": "video", "--legenda": "legenda", "--quando": "quando", "--chave": "chave", "--campanha": "campanha", "--comentario": "comentario" };
  for (let i = 0; i < argv.length; i += 2) {
    const k = keys[argv[i]];
    if (!k || argv[i + 1] === undefined) throw new Error(`argumento inválido: ${argv[i]}`);
    out[k] = argv[i + 1];
  }
  for (const req of ["video", "legenda", "quando", "chave"]) if (!out[req]) throw new Error(`falta --${req}`);
  if (Number.isNaN(Date.parse(out.quando)) || !/[+-]\d\d:\d\d$|Z$/.test(out.quando)) throw new Error("--quando precisa de data ISO com fuso");
  return out;
}

async function call(base, token, secret, path, payload, fetchImpl) {
  const body = JSON.stringify(payload);
  const ts = String(Date.now());
  const res = await fetchImpl(`${base}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-automation-timestamp": ts,
      "x-automation-signature": sign(secret, ts, "POST", path, body),
    },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.ok) throw new Error(`${path} → HTTP ${res.status}: ${json.error ?? "sem detalhe"}${json.detalhes ? ` (${json.detalhes.join("; ")})` : ""}`);
  return json.data;
}

export async function run(argv, env = process.env, fetchImpl = fetch) {
  const a = parseArgs(argv);
  const base = (env.NEWS_AUTOMATION_URL ?? "https://news.iron-security.com").replace(/\/+$/, "");
  const token = env.AUTOMATION_TOKEN;
  const secret = env.AUTOMATION_HMAC_SECRET;
  if (!token || !secret) throw new Error("defina AUTOMATION_TOKEN e AUTOMATION_HMAC_SECRET");

  const size = (await stat(a.video)).size;
  if (size <= 0 || size > MAX_VIDEO_BYTES) throw new Error("vídeo vazio ou acima de 500 MB");
  const caption = (await readFile(a.legenda, "utf8")).trim();
  const comment = a.comentario ? (await readFile(a.comentario, "utf8")).trim() : undefined;

  // 1) caminho + URL assinada; 2) MP4 direto ao Storage; 3) agenda.
  const up = await call(base, token, secret, "/api/automation/v1/uploads", {}, fetchImpl);
  const put = await fetchImpl(up.signed_url, {
    method: "PUT",
    headers: { "content-type": "video/mp4", "x-upsert": "false" },
    body: await readFile(a.video),
    signal: AbortSignal.timeout(600_000),
  });
  if (!put.ok) throw new Error(`upload do vídeo → HTTP ${put.status}`);

  return call(base, token, secret, "/api/automation/v1/linkedin-video", {
    campaign: a.campanha,
    caption,
    media_path: up.path,
    scheduled_for: a.quando,
    dedupe_key: a.chave,
    ...(comment ? { first_comment: comment } : {}),
  }, fetchImpl);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  run(process.argv.slice(2))
    .then((data) => process.stdout.write(`${JSON.stringify(data)}\n`))
    .catch((err) => { process.stderr.write(`erro: ${err.message}\n`); process.exit(1); });
}
