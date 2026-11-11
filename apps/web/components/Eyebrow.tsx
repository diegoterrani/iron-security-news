import type { ReactNode } from "react";

/** Eyebrow do design system: mono 600 12px, tracking .15em, teal, com traço de 25px. */
export function Eyebrow({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <p className="eyebrow" id={id}>
      <span aria-hidden="true" />
      {children}
    </p>
  );
}
