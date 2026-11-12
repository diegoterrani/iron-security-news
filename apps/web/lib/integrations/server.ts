// Só servidor: lê segredos de process.env (nunca importar em componente "use client").
import { siteUrl } from "@/lib/supabase/env";
import { instagramConfig, type InstagramConfig } from "./instagram";
import { linkedinConfig, type LinkedinConfig, type LinkedinTarget } from "./linkedin";

/** Tudo que a conexão do Instagram precisa no servidor. `null` = falta configurar (a tela avisa). */
export interface InstagramServerEnv {
  ig: InstagramConfig;
  tokenKey: string;
  stateSecret: string;
}

export function instagramServerEnv(): InstagramServerEnv | null {
  const ig = instagramConfig(process.env, siteUrl());
  const tokenKey = process.env.TOKEN_ENC_KEY;
  const stateSecret = process.env.OAUTH_STATE_SECRET;
  if (!ig || !tokenKey || !stateSecret || stateSecret.length < 32) return null;
  return { ig, tokenKey, stateSecret };
}

/** Para colar o token manualmente basta a chave de cifra (o app ID/secret só servem ao OAuth). */
export function tokenOnlyEnv(): { tokenKey: string; graphVersion: string } | null {
  const tokenKey = process.env.TOKEN_ENC_KEY;
  if (!tokenKey) return null;
  const v = process.env.INSTAGRAM_GRAPH_VERSION ?? "";
  return { tokenKey, graphVersion: /^v\d+\.\d+$/.test(v) ? v : "v23.0" };
}

/** Tudo que a conexão do LinkedIn (perfil ou página) precisa no servidor. `null` = falta configurar. */
export interface LinkedinServerEnv {
  li: LinkedinConfig;
  tokenKey: string;
  stateSecret: string;
}

export function linkedinServerEnv(target: LinkedinTarget): LinkedinServerEnv | null {
  const li = linkedinConfig(target, process.env, siteUrl());
  const tokenKey = process.env.TOKEN_ENC_KEY;
  const stateSecret = process.env.OAUTH_STATE_SECRET;
  if (!li || !tokenKey || !stateSecret || stateSecret.length < 32) return null;
  return { li, tokenKey, stateSecret };
}
