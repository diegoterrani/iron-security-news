/**
 * Campanhas (/admin/campanhas): destinos aceitos e regras de entrada. Repete as regras da RPC
 * campaign_post_create só para dar a mensagem antes do upload; quem decide é o banco.
 */
export type CampaignChannel = "instagram" | "linkedin";
export type CampaignTarget = "default" | "member" | "organization";
export type CampaignFormat = "reel" | "carousel" | "video" | "document" | "image";

export interface Destination {
  label: string;
  channel: CampaignChannel;
  target: CampaignTarget;
  format: CampaignFormat;
  exts: string[];
  accept: string;
  min: number;
  max: number;
  maxMb: number;
  captionMax: number;
  /** LinkedIn: 1º comentário (link) e título da mídia. */
  firstComment: boolean;
  needsTitle: boolean;
}

const IMG = { exts: ["jpg", "jpeg", "png"], accept: ".jpg,.jpeg,.png,image/jpeg,image/png" };
const MP4 = { exts: ["mp4"], accept: ".mp4,video/mp4" };
const PDF = { exts: ["pdf"], accept: ".pdf,application/pdf" };
const ig = { channel: "instagram", target: "default", captionMax: 2200, firstComment: false, needsTitle: false } as const;
const li = (target: "member" | "organization") => ({ channel: "linkedin", target, captionMax: 3000, firstComment: true } as const);

export const DESTINATIONS = {
  ig_reel: { ...ig, label: "Instagram · Reels (vídeo)", format: "reel", ...MP4, min: 1, max: 1, maxMb: 300 },
  ig_carousel: { ...ig, label: "Instagram · Carrossel (2 a 10 imagens)", format: "carousel", ...IMG, min: 2, max: 10, maxMb: 8 },
  li_member_video: { ...li("member"), label: "LinkedIn perfil · Vídeo", format: "video", ...MP4, min: 1, max: 1, maxMb: 500, needsTitle: false },
  li_member_document: { ...li("member"), label: "LinkedIn perfil · Carrossel PDF", format: "document", ...PDF, min: 1, max: 1, maxMb: 100, needsTitle: true },
  li_member_image: { ...li("member"), label: "LinkedIn perfil · Imagem", format: "image", ...IMG, min: 1, max: 1, maxMb: 8, needsTitle: false },
  li_org_video: { ...li("organization"), label: "LinkedIn página IRON · Vídeo", format: "video", ...MP4, min: 1, max: 1, maxMb: 500, needsTitle: false },
  li_org_document: { ...li("organization"), label: "LinkedIn página IRON · Carrossel PDF", format: "document", ...PDF, min: 1, max: 1, maxMb: 100, needsTitle: true },
  li_org_image: { ...li("organization"), label: "LinkedIn página IRON · Imagem", format: "image", ...IMG, min: 1, max: 1, maxMb: 8, needsTitle: false },
} satisfies Record<string, Destination>;

export type DestinationKey = keyof typeof DESTINATIONS;
export const DESTINATION_KEYS = Object.keys(DESTINATIONS) as DestinationKey[];

export const isDestinationKey = (v: unknown): v is DestinationKey => typeof v === "string" && Object.hasOwn(DESTINATIONS, v);

/** Mesmo padrão da policy do Storage e da RPC. */
export const MEDIA_PATH_RE = /^campanhas\/[0-9a-f-]{36}\/[A-Za-z0-9._-]{1,100}\.(mp4|jpg|jpeg|png|pdf)$/;

export const extOf = (name: string) => (name.match(/\.([A-Za-z0-9]+)$/)?.[1] ?? "").toLowerCase();

/** Nome seguro no Storage: posição + nome original sem acentos/espaços + extensão. */
export function storageName(index: number, original: string): string {
  const ext = extOf(original);
  const base = original.replace(/\.[^.]*$/, "").normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "arquivo";
  return `${String(index + 1).padStart(2, "0")}-${base}.${ext}`;
}

/** Confere quantidade, extensão e tamanho dos arquivos escolhidos. `null` = tudo certo. */
export function checkFiles(dest: Destination, files: { name: string; size: number }[]): string | null {
  if (files.length < dest.min || files.length > dest.max) {
    return dest.min === dest.max ? `Escolha ${dest.min} arquivo.` : `Escolha de ${dest.min} a ${dest.max} arquivos.`;
  }
  for (const f of files) {
    if (!dest.exts.includes(extOf(f.name))) return `${f.name}: use ${dest.exts.map((e) => `.${e}`).join(", ")}.`;
    if (f.size <= 0 || f.size > dest.maxMb * 1024 * 1024) return `${f.name}: até ${dest.maxMb} MB.`;
  }
  return null;
}

/**
 * "2026-11-27T12:00" digitado no horário de Brasília → ISO com -03:00 (o Brasil não tem horário de verão
 * desde 2019). `null` se o formato não bate.
 */
export function brasiliaToIso(local: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) return null;
  const d = new Date(`${local}:00-03:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Tamanho que a legenda terá no LinkedIn depois do escape do "little text" e das #hashtags virarem
 * {hashtag|\\#|Tag} (mesma regra de campaignCommentary no executor). A API aceita até 3.000.
 */
export function linkedinCaptionLength(text: string): number {
  const RESERVED = /[\\|{}@[\]()<>#*_~]/g;
  const escaped = (s: string) => s.length + (s.match(RESERVED)?.length ?? 0);
  let total = 0;
  let last = 0;
  for (const m of text.matchAll(/#([\p{L}\p{N}]+)/gu)) {
    const at = m.index ?? 0;
    if (at > 0 && /[\p{L}\p{N}]/u.test(text[at - 1]!)) continue;
    if (!/\p{L}/u.test(m[1]!)) continue; // "#3" não é hashtag (mesma regra do executor)
    total += escaped(text.slice(last, at)) + `{hashtag|\\#|${m[1]}}`.length;
    last = at + m[0].length;
  }
  return total + escaped(text.slice(last));
}

/** Tamanho efetivo da legenda no destino (LinkedIn conta o texto já escapado). */
export const captionLength = (dest: Destination, text: string) =>
  dest.channel === "linkedin" ? linkedinCaptionLength(text.trim()) : text.trim().length;

export const POST_STATUS_LABEL = {
  pending: "Agendada", publishing: "Publicando", published: "Publicada", failed: "Falhou", skipped: "Cancelada",
} as const;
export type CampaignPostStatus = keyof typeof POST_STATUS_LABEL;

/** Rótulo do destino a partir da linha do banco. */
export function destinationLabel(channel: string, target: string, format: string): string {
  const hit = DESTINATION_KEYS.find((k) => {
    const d = DESTINATIONS[k];
    return d.channel === channel && d.target === target && d.format === format;
  });
  return hit ? DESTINATIONS[hit].label : `${channel} · ${format}`;
}
