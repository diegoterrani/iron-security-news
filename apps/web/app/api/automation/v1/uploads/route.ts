import { auditAgentCall, type AuditOutcome } from "@/lib/agent/audit";
import { requireAutomation } from "@/lib/automation/auth";
import { MAX_BODY_BYTES, MEDIA_BUCKET, newAutomationMediaPath } from "@/lib/automation/linkedin-video";

export const dynamic = "force-dynamic";

/**
 * POST /api/automation/v1/uploads — reserva um caminho para 1 vídeo MP4 e devolve uma URL de upload
 * assinada do Storage (vale 2 h, uso único, sem sobrescrever). O MP4 vai direto do cliente ao Storage,
 * porque a função da Vercel não aceita corpos grandes.
 *   200 { ok: true, data: { path, signed_url } }
 * Corpo: "{}" (assinado como os demais).
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
  const path = newAutomationMediaPath();
  const respond = async (status: number, body: Record<string, unknown>) => {
    await auditAgentCall(db, { tool: "automation.upload", sender: null, actor, args: { path }, outcome, error: errorMsg, durationMs: Date.now() - started });
    return Response.json(body, { status });
  };

  const { data, error } = await db.storage.from(MEDIA_BUCKET).createSignedUploadUrl(path);
  if (error || !data?.signedUrl) {
    errorMsg = error?.message ?? "sem URL";
    console.error("[automation upload] falha ao assinar", { message: errorMsg });
    return respond(500, { ok: false, error: "Falha ao preparar o upload" });
  }
  outcome = "ok";
  return respond(200, { ok: true, data: { path, signed_url: data.signedUrl } });
}
