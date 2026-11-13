import { z } from "zod";
import { requireAgent } from "@/lib/agent/auth";
import { auditAgentCall, type AuditOutcome } from "@/lib/agent/audit";
import { consumeConfirmation, createConfirmation } from "@/lib/agent/confirm";
import { AgentError } from "@/lib/agent/db";
import { findTool } from "@/lib/agent/tools";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 64 * 1024;

const envelopeSchema = z.object({
  args: z.record(z.string(), z.unknown()).default({}),
  confirmation: z.object({ id: z.string().uuid(), code: z.string().regex(/^\d{6}$/) }).optional(),
});

/**
 * POST /api/agent/v1/tools/:name — executa uma ferramenta. Corpo: { args, confirmation?: { id, code } }.
 *   200 { ok: true, data }                                                            executou
 *   200 { ok: true, status: 'confirmation_required', preview, confirmation_id, code } precisa do código
 *       (o servidor MCP envia `code` direto ao WhatsApp do admin e NÃO o repassa ao LLM)
 *   4xx/5xx { ok: false, error }
 */
export async function POST(request: Request, { params }: { params: Promise<{ name: string }> }) {
  const started = Date.now();
  const bodyText = await request.text();
  if (bodyText.length > MAX_BODY_BYTES) return Response.json({ ok: false, error: "Payload too large" }, { status: 413 });

  const auth = await requireAgent(request, bodyText);
  if (!auth.ok) return auth.response;
  const ctx = auth.ctx;
  const { name } = await params;

  let outcome: AuditOutcome = "error";
  let errorMsg: string | undefined;
  let args: unknown = null;
  const respond = async (status: number, body: Record<string, unknown>) => {
    await auditAgentCall(ctx.db, { tool: name, sender: ctx.sender, actor: ctx.actor, args, outcome, error: errorMsg, durationMs: Date.now() - started });
    return Response.json(body, { status });
  };

  const tool = findTool(name);
  if (!tool) {
    outcome = "denied";
    errorMsg = "unknown tool";
    return respond(404, { ok: false, error: "Ferramenta não existe" });
  }

  let json: unknown;
  try {
    json = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    outcome = "invalid";
    return respond(400, { ok: false, error: "JSON inválido" });
  }
  const envelope = envelopeSchema.safeParse(json);
  if (!envelope.success) {
    outcome = "invalid";
    return respond(400, { ok: false, error: "Envelope inválido: use { args, confirmation? }" });
  }
  args = envelope.data.args;
  const parsed = tool.input.safeParse(envelope.data.args);
  if (!parsed.success) {
    outcome = "invalid";
    const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "(raiz)"}: ${i.message}`);
    errorMsg = issues.join("; ");
    return respond(400, { ok: false, error: "Argumentos inválidos", detalhes: issues });
  }

  try {
    if (tool.confirm) {
      const confirmation = envelope.data.confirmation;
      if (!confirmation) {
        const preview = await tool.confirm(parsed.data, ctx);
        const { id, code, expiresAt } = await createConfirmation(ctx.db, { tool: tool.name, args: envelope.data.args, actor: ctx.actor, preview });
        outcome = "confirmation_required";
        return respond(200, { ok: true, status: "confirmation_required", preview, confirmation_id: id, code, expires_at: expiresAt });
      }
      const result = await consumeConfirmation(ctx.db, {
        id: confirmation.id, code: confirmation.code, tool: tool.name, args: envelope.data.args, actor: ctx.actor,
      });
      if (result !== "ok") {
        outcome = "denied";
        errorMsg = `confirmation ${result}`;
        const error = result === "wrong_code"
          ? "Código incorreto. Peça ao admin para conferir o código recebido."
          : "Confirmação inválida, expirada, já usada ou com tentativas esgotadas. Peça a ação de novo.";
        return respond(409, { ok: false, error });
      }
    }

    const data = await tool.run(parsed.data, ctx);
    outcome = "ok";
    return respond(200, { ok: true, data });
  } catch (error) {
    if (error instanceof AgentError) {
      outcome = "invalid";
      errorMsg = error.message;
      return respond(error.status, { ok: false, error: error.message });
    }
    outcome = "error";
    errorMsg = error instanceof Error ? error.message : String(error);
    console.error("[agent tool]", { tool: name, message: errorMsg });
    return respond(500, { ok: false, error: "Falha ao executar a ferramenta" });
  }
}
