"use client";
import { useMemo, useRef, useState } from "react";
import { CalendarClock, Send, Upload } from "lucide-react";
import {
  DESTINATIONS, DESTINATION_KEYS, checkFiles, storageName, type DestinationKey,
} from "@/lib/admin/campaigns";
import { createClient } from "@/lib/supabase/client";
import { createCampaignPost, type CampaignActionState } from "./actions";

/**
 * Nova publicação de campanha. Os arquivos sobem direto do navegador para o Storage do NEWS
 * (media/campanhas/<uuid>/…; a policy só deixa admin com MFA), sem passar pela Vercel, que limita o
 * corpo das requisições. Depois a server action agenda pela RPC, que confere tudo de novo no banco.
 */
export function CampaignForm({ available }: { available: Record<DestinationKey, boolean> }) {
  const firstAvailable = DESTINATION_KEYS.find((k) => available[k]) ?? "ig_reel";
  const [destKey, setDestKey] = useState<DestinationKey>(firstAvailable);
  const [files, setFiles] = useState<File[]>([]);
  const [caption, setCaption] = useState("");
  const [now, setNow] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [state, setState] = useState<CampaignActionState>({});
  const formRef = useRef<HTMLFormElement>(null);
  const dest = DESTINATIONS[destKey];
  const fileError = useMemo(() => (files.length ? checkFiles(dest, files) : null), [dest, files]);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setState({});
    const form = new FormData(e.currentTarget);
    const err = checkFiles(dest, files);
    if (err) return setState({ ok: false, message: err });
    const when = now ? "" : String(form.get("when") ?? "");
    if (!now && !when) return setState({ ok: false, message: "Escolha a data e a hora." });
    const where = now ? "agora" : `em ${when.replace("T", " às ")} (Brasília)`;
    if (!confirm(`Publicar ${where} em: ${dest.label}? O post fica público no horário.`)) return;

    try {
      // 1) Upload (um diretório novo por publicação; nada é sobrescrito).
      const supabase = createClient();
      const folder = `campanhas/${crypto.randomUUID()}`;
      const paths: string[] = [];
      for (const [i, file] of files.entries()) {
        setBusy(`Enviando ${i + 1} de ${files.length}: ${file.name}…`);
        const path = `${folder}/${storageName(i, file.name)}`;
        const { error } = await supabase.storage.from("media").upload(path, file, {
          upsert: false, cacheControl: "31536000", contentType: file.type || undefined,
        });
        if (error) {
          setBusy(null);
          return setState({ ok: false, message: `Falha ao enviar ${file.name}: ${error.message}` });
        }
        paths.push(path);
      }
      // 2) Agendamento (regras finais no banco).
      setBusy("Agendando…");
      const r = await createCampaignPost({
        destination: destKey,
        campaign: form.get("campaign"),
        caption,
        first_comment: dest.firstComment ? String(form.get("first_comment") ?? "") : undefined,
        doc_title: String(form.get("doc_title") ?? ""),
        media: paths,
        when: when || undefined,
      });
      setState(r);
      if (r.ok) {
        setFiles([]);
        setCaption("");
        formRef.current?.reset();
      }
    } catch (err) {
      setState({ ok: false, message: `Erro inesperado: ${(err as Error).message}` });
    } finally {
      setBusy(null);
    }
  }

  return (
    <form ref={formRef} className="form" onSubmit={onSubmit} autoComplete="off">
      <label className="form__label" htmlFor="c-dest">Destino</label>
      <select id="c-dest" className="input" value={destKey} onChange={(e) => { setDestKey(e.target.value as DestinationKey); setFiles([]); }}>
        {DESTINATION_KEYS.map((k) => (
          <option key={k} value={k} disabled={!available[k]}>{DESTINATIONS[k].label}{available[k] ? "" : " (conta não conectada)"}</option>
        ))}
      </select>

      <label className="form__label" htmlFor="c-campaign">Campanha</label>
      <input id="c-campaign" name="campaign" className="input" required maxLength={80} placeholder="Ex.: Cyber Assessment · Dia 2" />

      <label className="form__label" htmlFor="c-files">
        {dest.max > 1 ? `Arquivos (${dest.min} a ${dest.max}, na ordem dos cards)` : "Arquivo"} · {dest.exts.map((x) => `.${x}`).join(", ")} · até {dest.maxMb} MB
      </label>
      <input id="c-files" type="file" className="input" accept={dest.accept} multiple={dest.max > 1} required
        onChange={(e) => setFiles([...(e.target.files ?? [])].sort((a, b) => a.name.localeCompare(b.name, "pt-BR", { numeric: true })))} />
      {files.length > 1 && <p className="section-hint">Ordem: {files.map((f) => f.name).join(" → ")}</p>}
      {fileError && <p className="form__error" role="alert">{fileError}</p>}

      {dest.needsTitle && (
        <>
          <label className="form__label" htmlFor="c-title">Título do documento (aparece no LinkedIn)</label>
          <input id="c-title" name="doc_title" className="input" required maxLength={200} placeholder="Ex.: O seu conselho já viu o diagnóstico?" />
        </>
      )}

      <label className="form__label" htmlFor="c-caption">Legenda · {caption.length}/{dest.captionMax}</label>
      <textarea id="c-caption" name="caption" className="input textarea" rows={10} required maxLength={dest.captionMax}
        value={caption} onChange={(e) => setCaption(e.target.value)}
        placeholder={dest.channel === "linkedin" ? "Texto do post. #Hashtags continuam clicáveis." : "Legenda do post, com as #hashtags no fim."} />

      {dest.firstComment && (
        <>
          <label className="form__label" htmlFor="c-comment">1º comentário (opcional, bom para o link e as fontes)</label>
          <textarea id="c-comment" name="first_comment" className="input textarea" rows={3} maxLength={1250} />
        </>
      )}

      <fieldset className="form" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="form__label">Quando</legend>
        <label><input type="radio" name="quando" checked={now} onChange={() => setNow(true)} /> Publicar agora</label>
        <label><input type="radio" name="quando" checked={!now} onChange={() => setNow(false)} /> Agendar (horário de Brasília)</label>
        {!now && <input name="when" type="datetime-local" className="input" required aria-label="Data e hora (Brasília)" />}
      </fieldset>

      <div className="review-actions">
        <button type="submit" className="button button--primary" disabled={busy !== null || !available[destKey] || Boolean(fileError)}>
          {busy ? <Upload className="icon" size={16} aria-hidden="true" /> : now ? <Send className="icon" size={16} aria-hidden="true" /> : <CalendarClock className="icon" size={16} aria-hidden="true" />}
          {busy ?? (now ? "Enviar e publicar" : "Enviar e agendar")}
        </button>
        {state.message && <p className={state.ok ? "form__ok" : "form__error"} role={state.ok ? "status" : "alert"}>{state.message}</p>}
      </div>
    </form>
  );
}
