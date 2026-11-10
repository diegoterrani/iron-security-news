import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";
import type { El } from "@ironnews/templates";
import satori from "satori";

type Font = { name: string; weight: 400 | 500 | 600 | 700 | 800; style: "normal"; data: Buffer };

const require = createRequire(import.meta.url);
let fontsPromise: Promise<Font[]> | null = null;

/** Manrope (500–800) e IBM Plex Mono (400–600) dos pacotes @fontsource, lidos uma vez por processo. */
function loadFonts(): Promise<Font[]> {
  fontsPromise ??= (async () => {
    const file = (pkg: string, name: string) =>
      readFile(path.join(path.dirname(require.resolve(`${pkg}/package.json`)), "files", name));
    const manrope = await Promise.all(([500, 600, 700, 800] as const).map(async (w) => ({
      name: "Manrope", weight: w, style: "normal" as const, data: await file("@fontsource/manrope", `manrope-latin-${w}-normal.woff`),
    })));
    const mono = await Promise.all(([400, 500, 600] as const).map(async (w) => ({
      name: "IBM Plex Mono", weight: w, style: "normal" as const, data: await file("@fontsource/ibm-plex-mono", `ibm-plex-mono-latin-${w}-normal.woff`),
    })));
    return [...manrope, ...mono];
  })();
  return fontsPromise;
}

/** Template (árvore de elementos do @ironnews/templates) → PNG. */
export async function renderPng(el: El, size: { width: number; height: number }): Promise<Buffer> {
  const svg = await satori(el as unknown as Parameters<typeof satori>[0], { ...size, fonts: await loadFonts() });
  return Buffer.from(new Resvg(svg, { fitTo: { mode: "width", value: size.width } }).render().asPng());
}
