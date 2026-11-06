import type { Metadata } from "next";
import { LockKeyhole, MailCheck, ShieldCheck, Smartphone } from "lucide-react";

export const metadata: Metadata = { title: { absolute: "Fila de revisão · Admin · IRON CYBER NEWS" } };

const ACCESS_STEPS = [
  { icon: MailCheck, title: "Magic link", text: "Login por e-mail, sem senha, apenas para editores cadastrados." },
  { icon: Smartphone, title: "TOTP obrigatório", text: "Segundo fator por aplicativo autenticador em toda sessão." },
  { icon: ShieldCheck, title: "Papéis", text: "Admin, editor e leitor, aplicados por RLS no banco." },
];

export default function ReviewQueue() {
  return (
    <>
      <header className="admin-header">
        <div>
          <h1 className="admin-header__title">Fila de revisão</h1>
          <p className="admin-header__subtitle">Aprovar, editar ou rejeitar o conteúdo gerado antes da publicação</p>
        </div>
        <span className="button button--primary" aria-disabled="true">
          <LockKeyhole className="icon" size={16} aria-hidden="true" />
          Entrar
        </span>
      </header>

      <main id="content" className="admin-main">
        <section className="panel panel--feed" aria-labelledby="locked-title">
          <div className="empty">
            <span className="empty__icon" aria-hidden="true">
              <LockKeyhole className="icon" size={22} />
            </span>
            <h2 id="locked-title" className="empty__title">Acesso restrito</h2>
            <p className="empty__text">
              O painel será liberado na Fase 1, junto com o login. Até lá, nenhum conteúdo é exibido ou publicado por aqui.
            </p>
          </div>
        </section>

        <section className="status-grid" aria-label="Controles de acesso">
          {ACCESS_STEPS.map(({ icon: Icon, title, text }) => (
            <article key={title} className="metric-card">
              <div className="metric-card__top">
                <span className="metric-card__label">{title}</span>
                <Icon className="icon metric-card__icon" size={18} aria-hidden="true" />
              </div>
              <p className="metric-card__hint">{text}</p>
            </article>
          ))}
        </section>
      </main>
    </>
  );
}
