import { auditAgentCall, type AuditOutcome } from "@/lib/agent/audit";
import { rpcError, AgentError } from "@/lib/agent/db";
import { requireAutomation } from "@/lib/automation/auth";
import { MAX_BODY_BYTES } from "@/lib/automation/linkedin-video";
import { whatsappGroupSchema, whatsappRpcArgs } from "@/lib/automation/whatsapp-group";

export const dynamic = "force-dynamic";

/**
 * POST /api/automation/v1/whatsapp-group — enfileira 1 mensagem de TEXTO para o grupo do WhatsApp, enviada
 * pelo relay da VPS quando send_after chegar. Reenvio com a mesma dedupe_key devolve o pedido existente.
 * Corpo: { body, send_after (ISO com fuso), dedupe_key }
 *   200 { ok: true, data: { id, status, send_after, duplicate } }
 *   4xx/5xx { ok: false, error }
 * O texto da mensagem não vai para o log (só tamanho e chave). O grupo de destino é fixo na VPS.
 */
export async function POST(request: Request) {
  const started = Date.now();
  const bodyText = await request.text();
  if (bodyText.length > MAX_BODY_BYTES) return Response.json({ ok: false, error: "Payload too large" }, { status: 413 });

  const auth = await requireAutomation(request, bodyText);
  if (!auth.ok) return auth.response;
  const { db, actor } = auth.ctx;

  let outcome: AuditOutcome = "error";
  let errorMsg: string | undefined;
  let logArgs: Record<string, unknown> | null = null;
  const respond = async (status: number, body: Record<string, unknown>) => {
    await auditAgentCall(db, { tool: "automation.whatsapp_group", sender: null, actor, args: logArgs, outcome, error: errorMsg, durationMs: Date.now() - started });
    return Response.json(body, { status });
  };

  let json: unknown;
  try {
    json = JSON.parse(bodyText);
  } catch {
    outcome = "invalid";
    return respond(400, { ok: false, error: "JSON inválido" });
  }
  const parsed = whatsappGroupSchema.safeParse(json);
  if (!parsed.success) {
    outcome = "invalid";
    const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "(raiz)"}: ${i.message}`);
    errorMsg = issues.join("; ");
    return respond(400, { ok: false, error: "Argumentos inválidos", detalhes: issues });
  }
  const input = parsed.data;
  logArgs = { dedupe_key: input.dedupe_key, send_after: input.send_after, body_chars: input.body.length };

  try {
    const { data, error } = await db.rpc("automation_whatsapp_group_create", whatsappRpcArgs(actor, input));
    if (error) throw rpcError(error.message);
    outcome = "ok";
    return respond(200, { ok: true, data });
  } catch (error) {
    if (error instanceof AgentError) {
      outcome = error.status >= 500 ? "error" : "invalid";
      errorMsg = error.message;
      return respond(error.status, { ok: false, error: error.message });
    }
    errorMsg = error instanceof Error ? error.message : String(error);
    console.error("[automation whatsapp-group]", { message: errorMsg });
    return respond(500, { ok: false, error: "Falha ao enfileirar" });
  }
}
