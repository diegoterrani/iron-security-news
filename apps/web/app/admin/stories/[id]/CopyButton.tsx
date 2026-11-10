"use client";
import { useState } from "react";
import { Check, Copy } from "lucide-react";

export function CopyButton({ text, label = "Copiar" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className="button" onClick={async () => {
      await navigator.clipboard.writeText(text);
      setDone(true);
      setTimeout(() => setDone(false), 1500);
    }}>
      {done ? <Check className="icon" size={16} aria-hidden="true" /> : <Copy className="icon" size={16} aria-hidden="true" />}
      {done ? "Copiado" : label}
    </button>
  );
}
