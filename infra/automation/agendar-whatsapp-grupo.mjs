#!/usr/bin/env node
/**
 * Enfileira 1 mensagem de TEXTO para o grupo do WhatsApp do News (sem navegador), para sair no horário
 * marcado pelo relay da VPS. Usado pelo agendamento diário do Plantão Cyber. Só Node 22, sem dependências.
 *
 * Uso:
 *   NEWS_AUTOMATION_URL=https://news.iron-security.com \
 *   AUTOMATION_TOKEN=... AUTOMATION_HMAC_SECRET=... \
 *   node agendar-whatsapp-grupo.mjs --mensagem whatsapp.txt \
 *     --quando 2026-11-28T18:00:00-03:00 --chave plantao-2026-11-28-whatsapp
 *
 * Saída (stdout, JSON): { id, status, send_after, duplicate }. Erros vão para stderr com código != 0.
 * Nunca imprime token, segredo nem o texto da mensagem.
 */
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { call } from "./agendar-linkedin-video.mjs";

const MAX_CHARS = 1500;

export function parseArgs(argv) {
  const out = {};
  const keys = { "--mensagem": "mensagem", "--quando": "quando", "--chave": "chave" };
  for (let i = 0; i < argv.length; i += 2) {
    const k = keys[argv[i]];
    if (!k || argv[i + 1] === undefined) throw new Error(`argumento inválido: ${argv[i]}`);
    out[k] = argv[i + 1];
  }
  for (const req of ["mensagem", "quando", "chave"]) if (!out[req]) throw new Error(`falta --${req}`);
  if (Number.isNaN(Date.parse(out.quando)) || !/[+-]\d\d:\d\d$|Z$/.test(out.quando)) throw new Error("--quando precisa de data ISO com fuso");
  return out;
}

export async function run(argv, env = process.env, fetchImpl = fetch) {
  const a = parseArgs(argv);
  const base = (env.NEWS_AUTOMATION_URL ?? "https://news.iron-security.com").replace(/\/+$/, "");
  const token = env.AUTOMATION_TOKEN;
  const secret = env.AUTOMATION_HMAC_SECRET;
  if (!token || !secret) throw new Error("defina AUTOMATION_TOKEN e AUTOMATION_HMAC_SECRET");

  const body = (await readFile(a.mensagem, "utf8")).trim();
  if (!body) throw new Error("mensagem vazia");
  if (body.length > MAX_CHARS) throw new Error(`mensagem com ${body.length} caracteres (máximo ${MAX_CHARS})`);

  return call(base, token, secret, "/api/automation/v1/whatsapp-group", {
    body,
    send_after: a.quando,
    dedupe_key: a.chave,
  }, fetchImpl);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  run(process.argv.slice(2))
    .then((data) => process.stdout.write(`${JSON.stringify(data)}\n`))
    .catch((err) => { process.stderr.write(`erro: ${err.message}\n`); process.exit(1); });
}
