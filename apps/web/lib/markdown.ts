/**
 * Tira a seção "## TL;DR" do corpo do artigo: a página já mostra o resumo em destaque no topo.
 * O texto gravado não muda (o redator segue a estrutura obrigatória do §4.12).
 */
export function withoutTldrSection(markdown: string): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex((l) => /^#{1,3}\s*TL;?\s*DR\b/i.test(l.trim()));
  if (start === -1) return markdown;
  let end = lines.findIndex((l, i) => i > start && /^#{1,3}\s+\S/.test(l.trim()));
  if (end === -1) end = lines.length;
  return [...lines.slice(0, start), ...lines.slice(end)].join("\n").replace(/^\s+/, "");
}
