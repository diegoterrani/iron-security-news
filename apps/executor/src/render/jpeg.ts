import { Resvg } from "@resvg/resvg-js";
import jpeg from "jpeg-js";

/**
 * PNG → JPEG para a API do Instagram, que só aceita JPEG em imagem de carrossel (§8.4).
 *
 * Por que assim: o Resvg (já usado no render) decodifica o PNG embutido num SVG e devolve os pixels
 * RGBA; o jpeg-js (JS puro, sem binário nativo) codifica. Nada de libvips/sharp na imagem do executor.
 * O fundo é pintado com a cor da marca antes, porque JPEG não tem transparência.
 */
const BG = "#090f0d";

export function pngToJpeg(png: Buffer, size: { width: number; height: number }, quality = 90): Buffer {
  if (!Number.isInteger(size.width) || !Number.isInteger(size.height) || size.width < 1 || size.height < 1 || size.width > 4000 || size.height > 4000) {
    throw new Error("dimensões inválidas para JPEG");
  }
  const { width, height } = size;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<rect width="100%" height="100%" fill="${BG}"/>` +
    `<image width="${width}" height="${height}" xlink:href="data:image/png;base64,${png.toString("base64")}"/></svg>`;
  const img = new Resvg(svg, { fitTo: { mode: "width", value: width } }).render();
  const out = jpeg.encode({ data: Buffer.from(img.pixels), width: img.width, height: img.height }, quality);
  return Buffer.from(out.data);
}
