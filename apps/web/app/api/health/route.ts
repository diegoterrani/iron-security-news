export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ status: "ok", service: "web", version: process.env.VERCEL_GIT_COMMIT_SHA ?? "dev" });
}
