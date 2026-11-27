/**
 * Guard das rotas /api/automation/v1/* (máquina a máquina: o agendamento diário do Plantão Cyber).
 * Mesmo contrato de assinatura da API do agente, com segredos PRÓPRIOS, para que um vazamento de um lado
 * não abra o outro:
 *   Authorization: Bearer <AUTOMATION_TOKEN>
 *   X-Automation-Timestamp: <unix ms>
 *   X-Automation-Signature: hex(HMAC-SHA256(AUTOMATION_HMAC_SECRET, `${ts}.${METHOD}.${path}.${body}`))
 * Ordem: kill switch → segredos distintos dos do agente → Bearer → limite → HMAC + janela → admin no banco.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { agentDb } from "../agent/db";
import { bearerMatches, safeEqual, verifySignature } from "../agent/signature";

export interface AutomationContext {
  db: SupabaseClient;
  /** profiles.id (admin) em nome de quem a automação age (AUTOMATION_ACTOR). */
  actor: string;
}

const deny = (status: number, error: string) => Response.json({ ok: false, error }, { status });

/** A automação faz 2 chamadas por dia; 10 por minuto já é folga e segura força bruta. */
export const AUTOMATION_RATE_LIMIT = 10;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Configuração mínima e separada da API do agente. Puro, para teste. */
export function automationConfigProblem(env: NodeJS.ProcessEnv): string | null {
  if (env.AUTOMATION_API_ENABLED !== "true") return "disabled";
  const token = env.AUTOMATION_TOKEN ?? "";
  const secret = env.AUTOMATION_HMAC_SECRET ?? "";
  if (token.length < 32 || secret.length < 32) return "missing secrets";
  if (safeEqual(token, secret)) return "token equals secret";
  if (env.AGENT_ADMIN_TOKEN && safeEqual(token, env.AGENT_ADMIN_TOKEN)) return "token reused from agent";
  if (env.AGENT_HMAC_SECRET && safeEqual(secret, env.AGENT_HMAC_SECRET)) return "secret reused from agent";
  if (!UUID_RE.test(env.AUTOMATION_ACTOR ?? "")) return "missing actor";
  return null;
}

export async function requireAutomation(
  request: Request,
  bodyText: string,
): Promise<{ ok: true; ctx: AutomationContext } | { ok: false; response: Response }> {
  const problem = automationConfigProblem(process.env);
  if (problem) {
    if (problem !== "disabled") console.error("[automation] configuração inválida", { problem });
    return { ok: false, response: deny(503, "Automation API disabled") };
  }
  if (!bearerMatches(request.headers.get("authorization"), process.env.AUTOMATION_TOKEN)) {
    return { ok: false, response: deny(401, "Unauthorized") };
  }

  const db = agentDb();
  const { data: limited, error: rlError } = await db.rpc("agent_rate_hit", {
    p_key: "automation", p_limit: AUTOMATION_RATE_LIMIT, p_window_seconds: 60,
  });
  if (rlError) {
    console.error("[automation] rate limit indisponível", rlError.message);
    return { ok: false, response: deny(503, "Temporarily unavailable") };
  }
  if (limited) return { ok: false, response: deny(429, "Too many requests") };

  const url = new URL(request.url);
  const signed = verifySignature({
    secret: process.env.AUTOMATION_HMAC_SECRET ?? "",
    timestamp: request.headers.get("x-automation-timestamp"),
    signature: request.headers.get("x-automation-signature"),
    method: request.method,
    path: url.pathname,
    body: bodyText,
  });
  if (!signed) return { ok: false, response: deny(401, "Unauthorized") };

  const actor = (process.env.AUTOMATION_ACTOR ?? "").toLowerCase();
  const { data: profile, error } = await db.from("profiles").select("role").eq("id", actor).maybeSingle();
  if (error || profile?.role !== "admin") return { ok: false, response: deny(403, "Forbidden") };

  return { ok: true, ctx: { db, actor } };
}
