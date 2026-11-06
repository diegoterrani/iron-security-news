import { revalidateTag } from "next/cache";
import { z } from "zod";
import { fail, ok, verifyRequest } from "@ironnews/shared";

export const dynamic = "force-dynamic";

const Body = z.object({
  tags: z.array(z.string().regex(/^[a-z]+(:[a-z0-9-]+)?$/).max(80)).min(1).max(20),
});

/** Chamado pelo executor após publicar (§5.5). Autenticado por HMAC + timestamp. */
export async function POST(req: Request) {
  const secret = process.env.REVALIDATE_SECRET ?? "";
  const raw = await req.text();
  if (raw.length > 4096) return Response.json(fail("VALIDATION_ERROR", "Payload too large"), { status: 413 });

  const valid = await verifyRequest(secret, raw, req.headers.get("x-timestamp"), req.headers.get("x-signature"));
  if (!valid) return Response.json(fail("UNAUTHENTICATED", "Invalid signature"), { status: 401 });

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return Response.json(fail("VALIDATION_ERROR", "Invalid JSON"), { status: 400 });
  }
  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    return Response.json(
      fail("VALIDATION_ERROR", "Invalid body", parsed.error.issues.map((i) => ({ field: i.path.join("."), message: i.message }))),
      { status: 422 },
    );
  }
  for (const tag of parsed.data.tags) revalidateTag(tag);
  return Response.json(ok({ revalidated: parsed.data.tags.length }));
}
