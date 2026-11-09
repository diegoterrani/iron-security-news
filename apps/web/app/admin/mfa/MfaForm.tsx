"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { KeyRound, ShieldCheck } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

type Mode = { kind: "loading" } | { kind: "verify"; factorId: string } | { kind: "enroll"; factorId: string; qr: string; secret: string } | { kind: "error"; message: string };

/** MFA obrigatório (§7.1): cadastra o TOTP no primeiro acesso; depois, só pede o código. */
export function MfaForm() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>({ kind: "loading" });
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    (async () => {
      const { data, error } = await supabase.auth.mfa.listFactors();
      if (error) return setMode({ kind: "error", message: "Não foi possível carregar a verificação. Entre de novo." });
      const verified = data.totp.find((f) => f.status === "verified");
      if (verified) return setMode({ kind: "verify", factorId: verified.id });
      // Cadastro interrompido deixa fator não verificado; remove antes de criar outro.
      for (const f of data.all.filter((f) => f.status !== "verified")) await supabase.auth.mfa.unenroll({ factorId: f.id });
      const en = await supabase.auth.mfa.enroll({ factorType: "totp", friendlyName: `IRON CYBER NEWS ${new Date().toISOString().slice(0, 10)}` });
      if (en.error) return setMode({ kind: "error", message: "Não foi possível iniciar o cadastro do autenticador." });
      setMode({ kind: "enroll", factorId: en.data.id, qr: en.data.totp.qr_code, secret: en.data.totp.secret });
    })();
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (mode.kind !== "verify" && mode.kind !== "enroll") return;
    setBusy(true);
    setError(null);
    const { error } = await createClient().auth.mfa.challengeAndVerify({ factorId: mode.factorId, code: code.trim() });
    setBusy(false);
    if (error) return setError("Código inválido ou expirado. Confira o relógio do celular e tente de novo.");
    router.replace("/admin");
    router.refresh();
  }

  if (mode.kind === "loading") return <p className="section-hint">Carregando…</p>;
  if (mode.kind === "error") return <p className="form__error" role="alert">{mode.message}</p>;

  return (
    <form onSubmit={submit} className="form">
      {mode.kind === "enroll" ? (
        <>
          <p className="section-hint">
            <ShieldCheck className="icon" size={14} aria-hidden="true" /> Primeiro acesso: leia o QR code com um aplicativo
            autenticador (Google Authenticator, Microsoft Authenticator, 1Password…) e digite o código de 6 dígitos.
          </p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="qr" src={mode.qr} alt="QR code para cadastrar o autenticador" width={200} height={200} />
          <p className="section-hint">Sem câmera? Digite a chave: <code className="mono">{mode.secret}</code></p>
        </>
      ) : (
        <p className="section-hint">Digite o código de 6 dígitos do seu aplicativo autenticador.</p>
      )}
      <label className="form__label" htmlFor="code">Código</label>
      <input id="code" name="code" className="input mono" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6}
        required value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
      {error && <p className="form__error" role="alert">{error}</p>}
      <button type="submit" className="button button--primary" disabled={busy || code.length !== 6}>
        <KeyRound className="icon" size={16} aria-hidden="true" />
        {busy ? "Verificando…" : "Verificar"}
      </button>
    </form>
  );
}
