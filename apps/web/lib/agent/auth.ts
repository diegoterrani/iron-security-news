/**
 * Guard das rotas /api/agent/v1/*. Ordem: kill switch → Bearer → limite de chamadas → HMAC + janela →
 * remetente em AGENT_ADMINS → perfil ainda admin no banco (checagem dupla, não só no OpenClaw).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { agentDb } from "./db";
import { bearerMatches, normalizePhone, parseAdminMap, verifySignature } from "./signature";

export interface AgentContext {
  db: SupabaseClient;
  /** Número do WhatsApp de quem falou com o agente (só dígitos). */
  sender: string;
  /** profiles.id (admin) em nome de quem o agente age. */
  actor: string;
}

const deny = (status: number, error: string) => Response.json({ ok: false, error }, { status });

/** 60 chamadas por minuto para o agente inteiro. */
const RATE_LIMIT = 60;

export async function requireAgent(
  request: Request,
  bodyText: string,
): Promise<{ ok: true; ctx: AgentContext } | { ok: false; response: Response }> {
  if (process.env.AGENT_API_ENABLED !== "true") return { ok: false, response: deny(503, "Agent API disabled") };
  if (!bearerMatches(request.headers.get("authorization"), process.env.AGENT_ADMIN_TOKEN)) {
    return { ok: false, response: deny(401, "Unauthorized") };
  }

  const db = agentDb();
  const { data: limited, error: rlError } = await db.rpc("agent_rate_hit", { p_key: "agent:admin", p_limit: RATE_LIMIT, p_window_seconds: 60 });
  if (rlError) {
    console.error("[agent] rate limit indisponível", rlError.message);
    return { ok: false, response: deny(503, "Temporarily unavailable") };
  }
  if (limited) return { ok: false, response: deny(429, "Too many requests") };

  const url = new URL(request.url);
  const signed = verifySignature({
    secret: process.env.AGENT_HMAC_SECRET ?? "",
    timestamp: request.headers.get("x-agent-timestamp"),
    signature: request.headers.get("x-agent-signature"),
    method: request.method,
    path: url.pathname,
    body: bodyText,
  });
  if (!signed) return { ok: false, response: deny(401, "Unauthorized") };

  const sender = normalizePhone(request.headers.get("x-wa-sender"));
  if (!sender) return { ok: false, response: deny(400, "Missing X-WA-Sender") };
  const actor = parseAdminMap(process.env.AGENT_ADMINS).get(sender);
  if (!actor) return { ok: false, response: deny(403, "Forbidden") };
  const { data: profile, error } = await db.from("profiles").select("role").eq("id", actor).maybeSingle();
  if (error || profile?.role !== "admin") return { ok: false, response: deny(403, "Forbidden") };

  return { ok: true, ctx: { db, sender, actor } };
}
