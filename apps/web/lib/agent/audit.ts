import type { SupabaseClient } from "@supabase/supabase-js";

export type AuditOutcome = "ok" | "confirmation_required" | "denied" | "invalid" | "error";

const MAX_ARGS_CHARS = 2000;

function compactArgs(args: unknown): unknown {
  if (!args || typeof args !== "object") return args ?? null;
  const json = JSON.stringify(args);
  return json.length <= MAX_ARGS_CHARS ? args : { truncated: json.slice(0, MAX_ARGS_CHARS) };
}

/** Grava a chamada do agente. Falha aqui não derruba a operação, mas fica no log. */
export async function auditAgentCall(
  db: SupabaseClient,
  row: { tool: string; sender: string | null; actor: string | null; args: unknown; outcome: AuditOutcome; error?: string; durationMs: number },
): Promise<void> {
  const { error } = await db.from("agent_audit_log").insert({
    tool: row.tool.slice(0, 80),
    wa_sender: row.sender,
    actor: row.actor,
    args: compactArgs(row.args),
    outcome: row.outcome,
    error: row.error?.slice(0, 500) ?? null,
    duration_ms: Math.round(row.durationMs),
  });
  if (error) console.error("[agent audit] falha ao gravar", { tool: row.tool, message: error.message });
}
