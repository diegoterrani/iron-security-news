"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { rpcErrorMessage } from "@/lib/admin/data";
import { createClient } from "@/lib/supabase/server";

export type ActionState = { ok?: boolean; message?: string };

const Uuid = z.string().uuid();

/** As regras (papel, MFA, estado) são checadas no banco pelas RPCs review_*; aqui só valida a entrada. */
async function call(fn: string, args: Record<string, unknown>, storyId: string): Promise<ActionState> {
  const supabase = await createClient();
  const { error } = await supabase.rpc(fn, args);
  if (error) return { ok: false, message: rpcErrorMessage(error.message) };
  revalidatePath("/admin");
  revalidatePath(`/admin/stories/${storyId}`);
  return { ok: true };
}

export async function approveStory(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = Uuid.safeParse(form.get("story_id"));
  if (!id.success) return { ok: false, message: "Story inválida." };
  const r = await call("review_approve", { p_story: id.data }, id.data);
  return r.ok ? { ok: true, message: "Story aprovada." } : r;
}

export async function rejectStory(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = Uuid.safeParse(form.get("story_id"));
  const reason = z.string().trim().min(3, "Explique o motivo (mínimo 3 caracteres).").max(500).safeParse(form.get("reason"));
  if (!id.success) return { ok: false, message: "Story inválida." };
  if (!reason.success) return { ok: false, message: reason.error.issues[0]?.message ?? "Motivo inválido." };
  const r = await call("review_reject", { p_story: id.data, p_reason: reason.data }, id.data);
  return r.ok ? { ok: true, message: "Story rejeitada." } : r;
}

/** Campos editáveis por tipo de conteúdo (o resto do corpo é preservado pela RPC). */
const EDITABLE: Record<string, string[]> = {
  "blog:article": ["tldr", "markdown", "meta_description"],
  "facebook:post": ["text"],
  "linkedin:post": ["text"],
  "instagram:carousel": ["caption"],
  "youtube:script": ["script"],
};

export async function editContent(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = Uuid.safeParse(form.get("story_id"));
  const channel = String(form.get("channel") ?? "");
  const kind = String(form.get("kind") ?? "");
  const lang = String(form.get("lang") ?? "");
  const fields = EDITABLE[`${channel}:${kind}`];
  if (!id.success || !fields || !["pt", "en"].includes(lang)) return { ok: false, message: "Conteúdo inválido." };
  const patch: Record<string, string> = {};
  for (const f of fields) {
    const v = form.get(f);
    if (typeof v === "string") patch[f] = v.replace(/\r\n/g, "\n").trim();
  }
  if (patch.markdown !== undefined && patch.markdown.length < 200) return { ok: false, message: "O artigo ficou curto demais." };
  const title = typeof form.get("title") === "string" ? String(form.get("title")).trim().slice(0, 120) : null;
  const r = await call("review_edit", { p_story: id.data, p_channel: channel, p_lang: lang, p_kind: kind, p_title: title, p_patch: patch }, id.data);
  return r.ok ? { ok: true, message: "Alteração salva como nova versão." } : r;
}
