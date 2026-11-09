import type { Metadata } from "next";
import { MfaForm } from "./MfaForm";

export const metadata: Metadata = { title: "Verificação em duas etapas" };

export default function Mfa() {
  return (
    <main id="content" className="admin-main admin-main--narrow">
      <section className="panel" aria-labelledby="mfa-title">
        <h1 id="mfa-title" className="section-title">Verificação em duas etapas</h1>
        <MfaForm />
        <form action="/admin/logout" method="post">
          <button type="submit" className="button">Sair</button>
        </form>
      </section>
    </main>
  );
}
