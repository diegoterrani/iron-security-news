import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;

/**
 * Cliente com a service_role, só para a API do agente (servidor). As escritas passam pelas RPCs agent_*,
 * que exigem um admin real em p_actor e registram via='whatsapp' no audit_log.
 */
export function agentDb(): SupabaseClient {
  if (client) return client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY ausentes");
  client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return client;
}

/** Erro de regra de negócio com status HTTP e mensagem segura para o agente. */
export class AgentError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "AgentError";
  }
}

/** Traduz os códigos das RPCs (vêm no texto do erro) para mensagens úteis no WhatsApp. */
export function rpcError(message: string): AgentError {
  if (message.includes("FORBIDDEN")) return new AgentError(403, "Seu usuário não é admin no News.");
  if (message.includes("INVALID_STATE")) return new AgentError(409, "A matéria mudou de estado (já foi revisada?). Consulte de novo.");
  if (message.includes("VALIDATION_ERROR")) return new AgentError(400, message.replace(/^.*VALIDATION_ERROR:?\s*/, "") || "Dados inválidos.");
  if (message.includes("NOT_FOUND")) return new AgentError(404, "Não encontrado.");
  return new AgentError(500, "Falha no banco do News.");
}
