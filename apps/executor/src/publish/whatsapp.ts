import type { Pool } from "../db";

/**
 * Envio ao grupo do WhatsApp. O executor só prepara: pega o próximo pedido, monta a mensagem e registra o
 * resultado. Dois tipos de pedido na mesma fila:
 *   - story do blog (painel, review_publish_whatsapp): capa + legenda montadas aqui;
 *   - texto pronto com horário (automação do Plantão Cyber, automation_whatsapp_group_create): só texto,
 *     o WhatsApp monta a prévia do link. Só sai quando send_after já passou. Quem envia é infra/vps/whatsapp-relay.sh, na VPS, pelo
 * gateway do OpenClaw (que só escuta em loopback e o container não alcança).
 */

export interface WhatsappJob {
  id: string;
  /** null no texto pronto da automação. */
  storyId: string | null;
  caption: string;
  /** null = mensagem só de texto (o relay não passa --media). */
  mediaUrl: string | null;
}

/** Envio parado em 'sending' por mais que isto: o relay caiu no meio e não sabemos se saiu. */
export const STALE_SENDING_MINUTES = 10;
const TLDR_MAX = 600;

/** Tira os marcadores de formatação do WhatsApp (*negrito*, _itálico_, ~tachado~, `mono`) do título. */
const plain = (s: string) => s.replace(/[*_~`]/g, "").replace(/\s+/g, " ").trim();

function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s.,;:–-]+$/, "")}…`;
}

/** Legenda: título em negrito, TL;DR e o link do artigo (o link vai inteiro, nunca cortado). */
export function whatsappCaption(p: { title: string; tldr: string; url: string }): string {
  const parts = [`*${plain(p.title)}*`];
  if (p.tldr.trim()) parts.push(clip(p.tldr, TLDR_MAX));
  parts.push(`Leia completo: ${p.url}`);
  return parts.join("\n\n");
}

/**
 * Pega o próximo pedido e o marca 'sending'. Antes, envios presos em 'sending' viram 'failed' (e não
 * voltam para a fila sozinhos): reenviar às cegas poderia duplicar a mensagem no grupo.
 * Só pega pedidos cujo send_after já passou (os da automação podem estar agendados para mais tarde).
 * Texto pronto vai como está. Story sem capa, artigo ou link falha com o motivo e o próximo é tentado.
 */
export async function claimWhatsappJob(pool: Pool): Promise<WhatsappJob | null> {
  await pool.query(
    `update whatsapp_posts set status = 'failed',
            last_error = 'envio interrompido; confira o grupo antes de tentar de novo'
      where status = 'sending' and claimed_at < now() - make_interval(mins => $1)`,
    [STALE_SENDING_MINUTES],
  );
  for (;;) {
    const { rows: [row] } = await pool.query<{ id: string; story_id: string | null; lang: string; body: string | null }>(
      `update whatsapp_posts set status = 'sending', claimed_at = now(), attempts = attempts + 1
        where id = (select id from whatsapp_posts where status = 'pending' and send_after <= now()
                     order by send_after, requested_at limit 1 for update skip locked)
       returning id, story_id, lang, body`,
    );
    if (!row) return null;
    if (row.body !== null) {
      const text = row.body.trim();
      if (text) return { id: row.id, storyId: null, caption: text, mediaUrl: null };
      await failWhatsappJob(pool, row.id, "mensagem vazia");
      continue;
    }
    if (!row.story_id) {
      await failWhatsappJob(pool, row.id, "pedido sem story e sem texto");
      continue;
    }
    const { rows: [d] } = await pool.query<{ title: string | null; tldr: string | null; url: string | null; cover: string | null }>(
      `select c.title, c.body->>'tldr' as tldr,
              (select external_url from channel_posts
                where story_id = $1 and channel = 'blog' and lang = $2 and status = 'published') as url,
              (select public_url from assets
                where story_id = $1 and channel = 'blog' and lang = $2 and kind = 'cover' and status = 'ready'
                order by updated_at desc limit 1) as cover
         from latest_contents c
        where c.story_id = $1 and c.channel = 'blog' and c.lang = $2 and c.kind = 'article'`,
      [row.story_id, row.lang],
    );
    const missing = !d?.title ? "artigo" : !d.url ? "link do blog" : !d.cover ? "capa" : null;
    if (missing) {
      await failWhatsappJob(pool, row.id, `sem ${missing}`);
      continue;
    }
    return {
      id: row.id,
      storyId: row.story_id,
      caption: whatsappCaption({ title: d!.title!, tldr: d!.tldr ?? "", url: d!.url! }),
      mediaUrl: d!.cover!,
    };
  }
}

export async function completeWhatsappJob(pool: Pool, id: string, messageId: string | null): Promise<boolean> {
  const { rowCount } = await pool.query(
    `update whatsapp_posts set status = 'sent', sent_at = now(), message_id = $2, last_error = null
      where id = $1 and status = 'sending'`,
    [id, messageId ? messageId.slice(0, 200) : null],
  );
  return rowCount === 1;
}

export async function failWhatsappJob(pool: Pool, id: string, error: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `update whatsapp_posts set status = 'failed', last_error = $2 where id = $1 and status = 'sending'`,
    [id, (error.replace(/\s+/g, " ").trim() || "erro desconhecido").slice(0, 500)],
  );
  return rowCount === 1;
}
