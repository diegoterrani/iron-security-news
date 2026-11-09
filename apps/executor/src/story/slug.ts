/** "Falha crítica no Windows: 1,5 mi afetados" → "falha-critica-no-windows-1-5-mi-afetados" (RN-STO04). */
export function slugify(title: string, max = 80): string {
  const s = title
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (s.length <= max) return s || "noticia";
  const cut = s.slice(0, max);
  return cut.slice(0, cut.lastIndexOf("-") > max * 0.6 ? cut.lastIndexOf("-") : max).replace(/-+$/, "");
}
