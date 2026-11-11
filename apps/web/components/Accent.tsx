import type { Accented } from "@/lib/i18n";

/** Renderiza [antes, destaque, depois]; o destaque ganha --accent via CSS (`.accent`). */
export function Accent({ parts }: { parts: Accented }) {
  const [before, highlight, after] = parts;
  return (
    <>
      {before}
      <span className="accent">{highlight}</span>
      {after}
    </>
  );
}
