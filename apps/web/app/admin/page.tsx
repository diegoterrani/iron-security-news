export const metadata = { title: "Admin", robots: { index: false, follow: false } };

// Fase 0: placeholder. Fase 1 adiciona Supabase Auth (magic link + TOTP) e a fila de revisão.
export default function Admin() {
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "64px 16px" }}>
      <h1>Painel de revisão</h1>
      <p>Em construção. O acesso exigirá login com MFA.</p>
    </main>
  );
}
