-- Integrações de redes sociais pelo painel (§4.9 tela "Integrações", §8.4).
-- A tabela integrations continua SEM policy para authenticated: o painel só fala com ela por estas RPCs.
-- Regras no banco (mesmo padrão das review_*): sessão com MFA (aal2); listar = viewer+; conectar e
-- desconectar = admin. O token chega já cifrado (AES-256-GCM no servidor do painel, chave fora do banco)
-- e nunca é devolvido por nenhuma RPC. Toda ação vai para audit_log, sem o token.

-- Lista o estado das integrações, sem nenhum campo de token.
create or replace function public.integrations_list()
returns table (
  channel channel, lang lang, account_name text, account_id text, status text,
  expires_at timestamptz, scopes text[], updated_at timestamptz
)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.review_guard('viewer');
  return query
    select i.channel, i.lang, i.account_name, i.account_id, i.status, i.expires_at, i.scopes, i.updated_at
      from integrations i
      join brands b on b.id = i.brand_id and b.slug = 'iron'
     order by i.channel, i.lang;
end $$;

-- Grava (ou substitui) a conta conectada de um canal. p_token_enc = base64 do token já cifrado.
create or replace function public.integration_save(
  p_channel channel, p_lang lang, p_account_id text, p_account_name text,
  p_token_enc text, p_expires_at timestamptz, p_scopes text[], p_meta jsonb default '{}'
) returns json
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := public.review_guard('admin');
  brand uuid;
  token bytea;
  rid uuid;
begin
  if p_channel = 'blog' then
    raise exception 'VALIDATION_ERROR: o blog não usa integração' using errcode = '22023';
  end if;
  if coalesce(p_account_id, '') !~ '^[0-9A-Za-z:_.-]{1,100}$' or char_length(coalesce(btrim(p_account_name), '')) not between 1 and 100 then
    raise exception 'VALIDATION_ERROR: conta inválida' using errcode = '22023';
  end if;
  if p_expires_at is not null and p_expires_at <= now() then
    raise exception 'VALIDATION_ERROR: token já expirado' using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_meta, '{}')) <> 'object' or octet_length(coalesce(p_meta, '{}')::text) > 4000 then
    raise exception 'VALIDATION_ERROR: meta inválido' using errcode = '22023';
  end if;
  begin
    token := decode(p_token_enc, 'base64');
  exception when others then
    raise exception 'VALIDATION_ERROR: token cifrado inválido' using errcode = '22023';
  end;
  -- v1 = 1 byte de versão + 12 de IV + 16 de tag + conteúdo. Rejeita token em texto puro por engano.
  if token is null or octet_length(token) < 30 or octet_length(token) > 8192 or get_byte(token, 0) <> 1 then
    raise exception 'VALIDATION_ERROR: token cifrado inválido' using errcode = '22023';
  end if;
  select id into brand from brands where slug = 'iron';
  if brand is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  insert into integrations (brand_id, channel, lang, account_name, account_id, access_token_enc,
                            refresh_token_enc, expires_at, scopes, status, meta)
  values (brand, p_channel, p_lang, btrim(p_account_name), p_account_id, token,
          null, p_expires_at, coalesce(p_scopes, '{}'), 'active', coalesce(p_meta, '{}'))
  on conflict (brand_id, channel, lang) do update set
    account_name = excluded.account_name, account_id = excluded.account_id,
    access_token_enc = excluded.access_token_enc, refresh_token_enc = null,
    expires_at = excluded.expires_at, scopes = excluded.scopes, status = 'active', meta = excluded.meta
  returning id into rid;

  insert into audit_log (actor, action, entity, entity_id, diff)
  values (uid, 'integration.connect', 'integration', rid::text,
          jsonb_build_object('channel', p_channel, 'lang', p_lang, 'account', btrim(p_account_name),
                             'account_id', p_account_id, 'expires_at', p_expires_at));
  return json_build_object('id', rid, 'status', 'active');
end $$;

-- Desconecta: apaga o token (não a linha, que channel_posts antigos referenciam) e marca disabled.
create or replace function public.integration_disconnect(p_channel channel, p_lang lang) returns json
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := public.review_guard('admin');
  rid uuid;
begin
  update integrations i set access_token_enc = '\x'::bytea, refresh_token_enc = null, expires_at = null, status = 'disabled'
    from brands b
   where b.id = i.brand_id and b.slug = 'iron' and i.channel = p_channel and i.lang = p_lang
  returning i.id into rid;
  if rid is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  insert into audit_log (actor, action, entity, entity_id, diff)
  values (uid, 'integration.disconnect', 'integration', rid::text, jsonb_build_object('channel', p_channel, 'lang', p_lang));
  return json_build_object('id', rid, 'status', 'disabled');
end $$;

revoke all on function public.integrations_list() from public, anon;
revoke all on function public.integration_save(channel, lang, text, text, text, timestamptz, text[], jsonb) from public, anon;
revoke all on function public.integration_disconnect(channel, lang) from public, anon;
grant execute on function public.integrations_list() to authenticated;
grant execute on function public.integration_save(channel, lang, text, text, text, timestamptz, text[], jsonb) to authenticated;
grant execute on function public.integration_disconnect(channel, lang) to authenticated;
