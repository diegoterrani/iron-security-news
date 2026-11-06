import { parseMetaSignedRequest, verifyHeygen } from "./verify";

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  HEYGEN_WEBHOOK_SECRET: string;
  META_APP_SECRET: string;
}

const MAX_BODY = 64 * 1024;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function log(level: "info" | "warn" | "error", msg: string, extra: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ level, service: "edge-hooks", msg, ...extra }));
}

async function readBody(req: Request): Promise<string | null> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > MAX_BODY) return null;
  const text = await req.text();
  return text.length > MAX_BODY ? null : text;
}

async function enqueueVideoEvent(env: Env, payload: Record<string, unknown>) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/enqueue_video_event`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ payload }),
  });
  if (!res.ok) throw new Error(`enqueue failed: ${res.status}`);
}

async function heygen(req: Request, env: Env) {
  const raw = await readBody(req);
  if (raw === null) return json({ error: "payload too large" }, 413);
  if (!(await verifyHeygen(env.HEYGEN_WEBHOOK_SECRET, raw, req.headers.get("signature")))) {
    log("warn", "heygen signature rejected");
    return json({ error: "unauthorized" }, 401);
  }
  let evt: { event_type?: string; event_data?: Record<string, unknown> };
  try {
    evt = JSON.parse(raw);
  } catch {
    return json({ error: "bad json" }, 400);
  }
  const type = evt.event_type;
  if (type !== "avatar_video.success" && type !== "avatar_video.fail") return json({ ignored: true });
  const d = evt.event_data ?? {};
  await enqueueVideoEvent(env, {
    event_type: type,
    video_id: String(d.video_id ?? ""),
    url: typeof d.url === "string" ? d.url : undefined,
    callback_id: typeof d.callback_id === "string" ? d.callback_id : undefined,
    msg: typeof d.msg === "string" ? d.msg.slice(0, 500) : undefined,
  });
  log("info", "heygen event enqueued", { type, video_id: d.video_id });
  return json({ ok: true });
}

async function metaSigned(req: Request, env: Env, kind: "deauthorize" | "data-deletion") {
  const raw = await readBody(req);
  if (raw === null) return json({ error: "payload too large" }, 413);
  const signed = new URLSearchParams(raw).get("signed_request") ?? "";
  const payload = await parseMetaSignedRequest(env.META_APP_SECRET, signed);
  if (!payload) return json({ error: "unauthorized" }, 401);
  // TODO(Fase 1): enfileirar `integration_revoked` / registrar pedido de exclusão.
  log("info", `meta ${kind}`, { meta_user: payload.user_id ? "present" : "absent" });
  if (kind === "data-deletion") {
    const code = crypto.randomUUID();
    const origin = new URL(req.url).origin;
    return json({ url: `${origin}/hooks/meta/data-deletion/status?id=${code}`, confirmation_code: code });
  }
  return json({ ok: true });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(req.url);
    try {
      if (req.method === "GET" && pathname === "/health") return json({ status: "ok", service: "edge-hooks" });
      if (req.method === "POST" && pathname === "/hooks/heygen") return await heygen(req, env);
      if (req.method === "POST" && pathname === "/hooks/meta/deauthorize") return await metaSigned(req, env, "deauthorize");
      if (req.method === "POST" && pathname === "/hooks/meta/data-deletion") return await metaSigned(req, env, "data-deletion");
      return json({ error: "not found" }, 404);
    } catch (err) {
      log("error", "handler failed", { path: pathname, err: (err as Error).message });
      return json({ error: "internal" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
