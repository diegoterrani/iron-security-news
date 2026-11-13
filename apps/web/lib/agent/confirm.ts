/**
 * Confirmação humana das ações que publicam, rejeitam ou desligam algo.
 * 1ª chamada: grava o pedido e devolve { confirmation_id, code, preview }. O servidor MCP manda o código
 *    (6 dígitos) DIRETO ao WhatsApp do admin e entrega ao LLM só o preview — o modelo nunca vê o código.
 * 2ª chamada: só executa se o código bater, para a mesma ferramenta, mesmos argumentos e mesmo admin,
 *    em até 10 min e com no máximo 3 tentativas.
 */
import { randomInt, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { canonicalJson, confirmCodeHash, safeEqual, sha256Hex } from "./signature";

export const CONFIRMATION_TTL_MS = 10 * 60 * 1000;
export const MAX_CONFIRMATION_ATTEMPTS = 3;

export async function createConfirmation(
  db: SupabaseClient,
  opts: { tool: string; args: unknown; actor: string; preview: string },
): Promise<{ id: string; code: string; expiresAt: string }> {
  const id = randomUUID();
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const expiresAt = new Date(Date.now() + CONFIRMATION_TTL_MS).toISOString();
  const { error } = await db.from("agent_confirmations").insert({
    id,
    code_hash: confirmCodeHash(id, code),
    tool: opts.tool,
    args_hash: sha256Hex(canonicalJson(opts.args)),
    actor: opts.actor,
    preview: opts.preview,
    expires_at: expiresAt,
  });
  if (error) throw new Error(error.message);
  return { id, code, expiresAt };
}

export type ConsumeResult = "ok" | "wrong_code" | "invalid";

export async function consumeConfirmation(
  db: SupabaseClient,
  opts: { id: string; code: string; tool: string; args: unknown; actor: string },
): Promise<ConsumeResult> {
  const { data: row, error } = await db
    .from("agent_confirmations")
    .select("id, code_hash, attempts")
    .eq("id", opts.id)
    .eq("tool", opts.tool)
    .eq("args_hash", sha256Hex(canonicalJson(opts.args)))
    .eq("actor", opts.actor)
    .is("used_at", null)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!row || row.attempts >= MAX_CONFIRMATION_ATTEMPTS) return "invalid";

  if (!safeEqual(confirmCodeHash(row.id, opts.code), row.code_hash)) {
    const { error: incError } = await db
      .from("agent_confirmations").update({ attempts: row.attempts + 1 }).eq("id", row.id).eq("attempts", row.attempts);
    if (incError) throw new Error(incError.message);
    return "wrong_code";
  }

  // Marca como usada de forma atômica: duas chamadas simultâneas não executam duas vezes.
  const { data: used, error: useError } = await db
    .from("agent_confirmations").update({ used_at: new Date().toISOString() })
    .eq("id", row.id).is("used_at", null).select("id").maybeSingle();
  if (useError) throw new Error(useError.message);
  return used ? "ok" : "invalid";
}
