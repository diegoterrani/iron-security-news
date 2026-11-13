import { requireAgent } from "@/lib/agent/auth";
import { toolManifest } from "@/lib/agent/tools";

export const dynamic = "force-dynamic";

/** GET /api/agent/v1/tools — manifesto das ferramentas (consumido pelo servidor MCP do OpenClaw). */
export async function GET(request: Request) {
  const auth = await requireAgent(request, "");
  if (!auth.ok) return auth.response;
  return Response.json({ ok: true, scope: "admin", tools: toolManifest() });
}
