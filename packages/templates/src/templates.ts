import { C, CATEGORY_WORD, MONO, RISK, SANS, SEVERITY_WORD, SITE, type Lang, type Severity } from "./tokens";

/** Elemento no formato que o Satori aceita (mesma forma de um elemento React, sem depender de React). */
export interface El {
  type: string;
  props: { style?: Style; src?: string; width?: number; height?: number; children?: Child | Child[] };
}
type Child = El | string;
type Style = Record<string, string | number>;

const h = (type: string, style: Style, ...children: Child[]): El => ({
  type,
  props: { style: { display: "flex", ...style }, children: children.length === 1 ? children[0] : children },
});

export interface StoryCreative {
  lang: Lang;
  severity: Severity;
  category: string;
  cves: string[];
  title: string;
  slug: string;
  /** Data URI do símbolo IRON (PNG recortado). */
  logo: string;
  /**
   * Ilustração de fundo gerada por IA sobre o tema (data URI), opcional. Entra sob o véu escuro esverdeado
   * do Brand Kit ("imagens com véu de --paper por cima"); sem ela, o fundo é liso.
   */
  background?: string;
}

export interface Slide {
  heading: string;
  body: string;
}

// ---------------------------------------------------------------------------
// Peças do kit

/** Símbolo + nome: "IRON" 800 e o resto 500, tracking .1em, maiúsculas. */
function brand(logo: string, size: number): El {
  return h("div", { alignItems: "center", gap: size * 0.45 },
    { type: "img", props: { src: logo, width: Math.round(size * 0.772), height: size, style: { width: Math.round(size * 0.772), height: size } } },
    h("div", { fontFamily: SANS, fontSize: size * 0.5, letterSpacing: "0.1em", color: C.text, gap: size * 0.22 },
      h("span", { fontWeight: 800 }, "IRON"),
      h("span", { fontWeight: 500, color: C.muted }, "CYBER NEWS")),
  );
}

/** Eyebrow: mono 600 maiúsculo, tracking .15em, traço de 25 px antes, em --teal. */
function eyebrow(text: string, size: number, color: string = C.teal): El {
  return h("div", { alignItems: "center", gap: size * 0.9, fontFamily: MONO, fontWeight: 600, fontSize: size, letterSpacing: "0.15em", color },
    h("div", { width: size * 2.1, height: 2, backgroundColor: color }),
    text.toUpperCase());
}

/** Tag de risco: preenchimento da escala misturado ao fundo, texto na tinta do nível, sempre com a palavra. */
function riskTag(sev: Severity, lang: Lang, size: number): El {
  const r = RISK[sev];
  const label = lang === "pt" ? `SEVERIDADE ${SEVERITY_WORD.pt[sev]}` : `${SEVERITY_WORD.en[sev]} SEVERITY`;
  return h("div", {
    alignItems: "center", gap: size * 0.7, padding: `${size * 0.55}px ${size * 0.9}px`,
    backgroundColor: `${r.fill}33`, border: `1px solid ${r.fill}`, color: r.ink,
    fontFamily: MONO, fontWeight: 600, fontSize: size, letterSpacing: "0.12em",
  },
  h("div", { width: size * 0.55, height: size * 0.55, backgroundColor: r.fill }),
  label);
}

/** Chip mono (CVE, escopo): raio 0, maiúsculo. */
function chip(text: string, size: number): El {
  return h("div", {
    padding: `${size * 0.55}px ${size * 0.8}px`, backgroundColor: "#17342a73", border: "1px solid #2a4a3d",
    color: "#8da99b", fontFamily: MONO, fontSize: size, letterSpacing: "0.06em",
  }, text.toUpperCase());
}

/**
 * Título em frase com UMA palavra no acento (regra do kit). Sem marcação manual, destaca a última
 * palavra com 4+ letras; `accent` permite escolher outra.
 */
export function pickAccent(text: string, accent?: string): number {
  const words = text.split(/\s+/);
  if (accent) {
    const i = words.findIndex((w) => w.toLowerCase().replace(/[^\p{L}\p{N}-]/gu, "") === accent.toLowerCase());
    if (i >= 0) return i;
  }
  for (let i = words.length - 1; i >= 0; i--) if (words[i]!.replace(/[^\p{L}]/gu, "").length >= 4) return i;
  return words.length - 1;
}

function headline(text: string, size: number, opts: { accent?: string; color?: string; weight?: number; maxWidth?: number } = {}): El {
  const words = text.trim().split(/\s+/);
  const ai = pickAccent(text, opts.accent);
  return h("div", {
    flexWrap: "wrap", fontFamily: SANS, fontWeight: opts.weight ?? 600, fontSize: size, lineHeight: 1.06,
    letterSpacing: "-0.045em", color: opts.color ?? C.text, maxWidth: opts.maxWidth ?? 9999,
  }, ...words.map((w, i) => h("span", i === ai ? { marginRight: size * 0.24, color: C.accent } : { marginRight: size * 0.24 }, w)));
}

function paragraph(text: string, size: number, color: string = C.muted): El {
  return h("div", { fontFamily: SANS, fontWeight: 400, fontSize: size, lineHeight: 1.5, color }, text);
}

/** Véus sobre a ilustração (cor --paper #090f0d): mais fortes onde fica o texto. */
const VEIL = {
  /** Cards largos: texto à esquerda, ilustração aparece à direita. */
  left: "linear-gradient(90deg, rgba(9,15,13,0.96) 0%, rgba(9,15,13,0.84) 45%, rgba(9,15,13,0.3) 100%)",
  /** Capas verticais: ilustração visível no topo, texto legível no meio e embaixo. */
  vertical: "linear-gradient(180deg, rgba(9,15,13,0.35) 0%, rgba(9,15,13,0.62) 30%, rgba(9,15,13,0.82) 62%, rgba(9,15,13,0.95) 100%)",
  /** Slides de texto e CTA: só textura. */
  texture: "linear-gradient(180deg, rgba(9,15,13,0.86) 0%, rgba(9,15,13,0.94) 100%)",
} as const;
type Veil = keyof typeof VEIL;

/** Fundo (--ink liso ou ilustração + véu) e o conteúdo por cima, no tamanho exato do criativo. */
function scene(w: number, h_: number, bg: string | undefined, veil: Veil, content: El): El {
  if (!bg) return h("div", { width: w, height: h_, backgroundColor: C.ink }, content);
  const layer = { position: "absolute", top: 0, left: 0, width: w, height: h_ } as const;
  return h("div", { width: w, height: h_, backgroundColor: C.ink, position: "relative" },
    { type: "img", props: { src: bg, width: w, height: h_, style: { ...layer, objectFit: "cover" } } },
    h("div", { ...layer, backgroundImage: VEIL[veil] }),
    h("div", { ...layer }, content));
}

/**
 * Moldura com padding. O conteúdo vai num contêiner de tamanho explícito: o Satori soma o padding à
 * largura, e sem isso o texto transborda a borda direita e o rodapé some.
 */
const frame = (w: number, h_: number, pad: number, bg: string | undefined, veil: Veil, ...children: Child[]): El =>
  scene(w, h_, bg, veil,
    h("div", { width: w, height: h_, padding: pad },
      h("div", { width: w - 2 * pad, height: h_ - 2 * pad, flexDirection: "column" }, ...children)));

/** Hairline horizontal de 1 px (--line). */
const hairline = () => h("div", { width: "100%", height: 1, backgroundColor: C.line });

const kicker = (s: StoryCreative) => `${CATEGORY_WORD[s.lang][s.category] ?? CATEGORY_WORD[s.lang].other}`;
const articleUrl = (s: StoryCreative) => `${SITE}/${s.lang}/${s.slug}`;

// ---------------------------------------------------------------------------
// Instagram (1080×1350): capa, slides de conteúdo e CTA final (RN-RND02)

export const CAROUSEL = { width: 1080, height: 1350 } as const;

export function carouselCover(s: StoryCreative, slide: Slide, total: number): El {
  return frame(CAROUSEL.width, CAROUSEL.height, 80, s.background, "vertical",
    h("div", { justifyContent: "space-between", alignItems: "center" },
      brand(s.logo, 56),
      h("div", { fontFamily: MONO, fontSize: 24, color: C.subtle, letterSpacing: "0.1em" }, `01 / ${String(total).padStart(2, "0")}`)),
    h("div", { flexDirection: "column", flexGrow: 1, justifyContent: "center", gap: 44 },
      eyebrow(kicker(s), 26),
      headline(slide.heading, 104, { maxWidth: 920 }),
      h("div", { gap: 16, flexWrap: "wrap" }, riskTag(s.severity, s.lang, 24), ...s.cves.slice(0, 2).map((c) => chip(c, 24)))),
    hairline(),
    h("div", { justifyContent: "space-between", alignItems: "center", paddingTop: 32 },
      h("div", { fontFamily: SANS, fontSize: 26, color: C.muted }, s.lang === "pt" ? "Arraste para entender o risco" : "Swipe to understand the risk"),
      arrowIcon(44, C.accent)),
  );
}

/** Ícone `arrow` do kit (grade 24, traço 1.8, pontas arredondadas): a Manrope não tem o glifo "→". */
function arrowIcon(size: number, color: string): El {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>`;
  return { type: "img", props: { src: `data:image/svg+xml;base64,${btoa(svg)}`, width: size, height: size, style: { width: size, height: size } } };
}

export function carouselSlide(s: StoryCreative, slide: Slide, index: number, total: number): El {
  return frame(CAROUSEL.width, CAROUSEL.height, 80, s.background, "texture",
    h("div", { justifyContent: "space-between", alignItems: "center" },
      brand(s.logo, 44),
      h("div", { fontFamily: MONO, fontSize: 24, color: C.subtle, letterSpacing: "0.1em" },
        `${String(index).padStart(2, "0")} / ${String(total).padStart(2, "0")}`)),
    h("div", { flexDirection: "column", flexGrow: 1, justifyContent: "center", gap: 40 },
      eyebrow(kicker(s), 24),
      headline(slide.heading, 80, { maxWidth: 920 }),
      h("div", { width: 120, height: 2, backgroundColor: C.accent }),
      paragraph(slide.body, 42, C.muted)),
    hairline(),
    h("div", { justifyContent: "space-between", paddingTop: 32, fontFamily: MONO, fontSize: 22, color: C.subtle, letterSpacing: "0.1em" },
      h("span", {}, SITE.toUpperCase()), h("span", {}, s.cves[0] ?? "")),
  );
}

export function carouselCta(s: StoryCreative, total: number): El {
  const pt = s.lang === "pt";
  return frame(CAROUSEL.width, CAROUSEL.height, 80, s.background, "texture",
    h("div", { justifyContent: "flex-end", fontFamily: MONO, fontSize: 24, color: C.subtle, letterSpacing: "0.1em" },
      `${String(total).padStart(2, "0")} / ${String(total).padStart(2, "0")}`),
    h("div", { flexDirection: "column", flexGrow: 1, justifyContent: "center", alignItems: "flex-start", gap: 48 },
      { type: "img", props: { src: s.logo, width: 185, height: 240, style: { width: 185, height: 240 } } },
      eyebrow(pt ? "Análise completa" : "Full analysis", 26),
      headline(pt ? "Leia a matéria completa no blog" : "Read the full story on the blog", 92, { accent: "blog", maxWidth: 900 }),
      h("div", { padding: "22px 30px", backgroundColor: C.band, border: `1px solid ${C.line}`, fontFamily: MONO, fontSize: 26, color: C.accentText, letterSpacing: "0.04em", maxWidth: 920 },
        articleUrl(s))),
    hairline(),
    h("div", { justifyContent: "space-between", alignItems: "center", paddingTop: 32 },
      brand(s.logo, 44),
      h("div", { fontFamily: SANS, fontSize: 24, color: C.muted }, pt ? "Segurança que antecipa." : "Security that anticipates.")),
  );
}

// ---------------------------------------------------------------------------
// LinkedIn (1200×627) e capa/Open Graph (1200×630)

export const CARD_LINKEDIN = { width: 1200, height: 627 } as const;
export const COVER = { width: 1200, height: 630 } as const;

/**
 * Capa do blog/OG e card do LinkedIn: largura toda, sem painel lateral com o escudo grande
 * (a marca fica no cabeçalho). Com ilustração, ela aparece à direita sob o véu.
 */
function wideCard(s: StoryCreative, size: { width: number; height: number }): El {
  const padX = 64, padTop = 56, padBottom = 52;
  return scene(size.width, size.height, s.background, "left",
    h("div", { width: size.width, height: size.height, padding: `${padTop}px ${padX}px ${padBottom}px` },
      h("div", { width: size.width - 2 * padX, height: size.height - padTop - padBottom, flexDirection: "column", justifyContent: "space-between" },
        brand(s.logo, 40),
        h("div", { flexDirection: "column", gap: 28 },
          eyebrow(kicker(s), 18),
          headline(s.title, s.title.length > 60 ? 52 : 60, { maxWidth: 860 })),
        h("div", { justifyContent: "space-between", alignItems: "center" },
          h("div", { gap: 12, flexWrap: "wrap" }, riskTag(s.severity, s.lang, 18), ...s.cves.slice(0, 2).map((c) => chip(c, 18))),
          h("span", { fontFamily: MONO, fontSize: 15, color: C.subtle, letterSpacing: "0.12em" }, SITE.toUpperCase())))));
}

export const cardLinkedin = (s: StoryCreative) => wideCard(s, CARD_LINKEDIN);
export const cover = (s: StoryCreative) => wideCard(s, COVER);

// ---------------------------------------------------------------------------
// Capa do Short (1080×1920)

export const THUMB_SHORT = { width: 1080, height: 1920 } as const;

export function thumbShort(s: StoryCreative, hook: string): El {
  return frame(THUMB_SHORT.width, THUMB_SHORT.height, 90, s.background, "vertical",
    h("div", { justifyContent: "center", paddingTop: 60 }, brand(s.logo, 64)),
    h("div", { flexDirection: "column", flexGrow: 1, justifyContent: "center", gap: 56 },
      eyebrow(kicker(s), 30),
      headline(hook, 128, { maxWidth: 900 }),
      h("div", { gap: 18, flexWrap: "wrap" }, riskTag(s.severity, s.lang, 30), ...s.cves.slice(0, 1).map((c) => chip(c, 30)))),
    hairline(),
    h("div", { justifyContent: "center", paddingTop: 40, paddingBottom: 140, fontFamily: MONO, fontSize: 28, color: C.subtle, letterSpacing: "0.12em" },
      SITE.toUpperCase()),
  );
}
