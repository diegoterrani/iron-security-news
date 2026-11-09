import type { Metadata } from "next";
import { LoginForm } from "./LoginForm";

export const metadata: Metadata = { title: "Entrar" };

export default async function Login({ searchParams }: { searchParams: Promise<{ erro?: string }> }) {
  const { erro } = await searchParams;
  return (
    <main id="content" className="admin-main admin-main--narrow">
      <section className="panel" aria-labelledby="login-title">
        <h1 id="login-title" className="section-title">Entrar no painel</h1>
        <p className="section-hint">
          Acesso só para editores cadastrados. Você recebe um link por e-mail e, em seguida, confirma com o código do
          aplicativo autenticador.
        </p>
        {erro && <p className="form__error" role="alert">O link expirou ou já foi usado. Peça um novo.</p>}
        <LoginForm />
      </section>
    </main>
  );
}
