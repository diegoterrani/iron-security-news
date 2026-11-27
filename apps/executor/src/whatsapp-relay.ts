/**
 * Lado do banco do envio ao grupo do WhatsApp, chamado pelo infra/vps/whatsapp-relay.sh (na VPS):
 *   node dist/whatsapp-relay.js claim              → JSON {id, storyId, caption, mediaUrl} ou {} (fila vazia);
 *                                                  mediaUrl null = só texto
 *   node dist/whatsapp-relay.js done <id> [msgId]  → marca enviado
 *   node dist/whatsapp-relay.js fail <id> <erro>   → marca falha (o painel mostra o motivo)
 */
import { loadConfig } from "./config";
import { createPool } from "./db";
import { claimWhatsappJob, completeWhatsappJob, failWhatsappJob } from "./publish/whatsapp";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const [cmd, id, ...rest] = process.argv.slice(2);
if (!(cmd === "claim" || ((cmd === "done" || cmd === "fail") && id && UUID.test(id)))) {
  console.error("uso: node dist/whatsapp-relay.js claim | done <id> [message-id] | fail <id> <erro>");
  process.exit(2);
}

const pool = createPool(loadConfig().DATABASE_URL);
try {
  if (cmd === "claim") {
    console.log(JSON.stringify((await claimWhatsappJob(pool)) ?? {}));
  } else {
    const ok = cmd === "done"
      ? await completeWhatsappJob(pool, id!, rest[0] || null)
      : await failWhatsappJob(pool, id!, rest.join(" "));
    if (!ok) {
      console.error(`pedido ${id} não está em envio`);
      process.exitCode = 1;
    }
  }
} finally {
  await pool.end();
}
