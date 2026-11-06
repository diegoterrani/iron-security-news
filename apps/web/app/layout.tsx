import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: { default: "IRON CYBER NEWS", template: "%s · IRON CYBER NEWS" },
  description: "Notícias de cibersegurança curadas pela Iron Security.",
  robots: { index: false, follow: false }, // Fase 0: não indexar até o lançamento
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR">
      <body style={{ margin: 0, fontFamily: "system-ui, sans-serif", background: "#0B0F14", color: "#E6EDF3" }}>
        {children}
      </body>
    </html>
  );
}
