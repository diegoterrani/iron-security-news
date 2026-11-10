/**
 * Prévia dos criativos com uma story real: renderiza todos os templates em PNG (Satori + resvg),
 * exatamente como o Worker og-render fará.
 * Uso: pnpm --filter @ironnews/templates preview <story.json> <pasta-de-saída>
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";
import satori from "satori";
import {
  CARD_LINKEDIN, CAROUSEL, COVER, THUMB_SHORT, cardLinkedin, carouselCover, carouselCta, carouselSlide, cover, thumbShort,
  type El, type Lang, type Severity, type Slide, type StoryCreative,
} from "../src/index";

const require = createRequire(import.meta.url);
const [storyFile, outDir] = process.argv.slice(2);
if (!storyFile || !outDir) throw new Error("uso: preview.ts <story.json> <saída>");

const font = (pkg: string, file: string) => readFile(path.join(path.dirname(require.resolve(`${pkg}/package.json`)), "files", file));
const fonts = [
  ...(await Promise.all([500, 600, 700, 800].map(async (w) => ({ name: "Manrope", weight: w as 500, style: "normal" as const, data: await font("@fontsource/manrope", `manrope-latin-${w}-normal.woff`) })))),
  ...(await Promise.all([400, 500, 600].map(async (w) => ({ name: "IBM Plex Mono", weight: w as 400, style: "normal" as const, data: await font("@fontsource/ibm-plex-mono", `ibm-plex-mono-latin-${w}-normal.woff`) })))),
];

const logo = `data:image/png;base64,${(await readFile(path.join(import.meta.dirname, "../assets/iron-mark.png"))).toString("base64")}`;

interface StoryJson {
  severity: Severity;
  category: string;
  cve_ids: string[];
  slug_pt: string;
  slug_en: string;
  pt: { title: string };
  en: { title: string };
  ig_slides: Slide[];
  yt: { hook: string };
}
const st = JSON.parse(await readFile(storyFile, "utf8")) as StoryJson;

async function png(el: El, size: { width: number; height: number }, name: string) {
  const svg = await satori(el as unknown as Parameters<typeof satori>[0], { ...size, fonts });
  const out = new Resvg(svg, { fitTo: { mode: "width", value: size.width } }).render().asPng();
  await writeFile(path.join(outDir!, name), out);
  console.log(`${name}  ${size.width}x${size.height}  ${(out.length / 1024).toFixed(0)} KB`);
}

await mkdir(outDir, { recursive: true });
const lang: Lang = "pt";
const s: StoryCreative = { lang, severity: st.severity, category: st.category, cves: st.cve_ids, title: st.pt.title, slug: st.slug_pt, logo };
const slides = st.ig_slides;
const total = slides.length + 1; // + CTA
await png(carouselCover(s, slides[0]!, total), CAROUSEL, "instagram-01-capa.png");
for (let i = 1; i < slides.length; i++) await png(carouselSlide(s, slides[i]!, i + 1, total), CAROUSEL, `instagram-0${i + 1}.png`);
await png(carouselCta(s, total), CAROUSEL, `instagram-0${total}-cta.png`);
await png(cardLinkedin(s), CARD_LINKEDIN, "linkedin.png");
await png(cover(s), COVER, "capa-blog-og.png");
await png(thumbShort(s, st.yt.hook), THUMB_SHORT, "short-capa.png");
await png(cardLinkedin({ ...s, lang: "en", title: st.en.title, slug: st.slug_en }), CARD_LINKEDIN, "linkedin-en.png");
