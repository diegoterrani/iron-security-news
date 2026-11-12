import { describe, expect, it } from "vitest";
import { Resvg } from "@resvg/resvg-js";
import jpeg from "jpeg-js";
import { pngToJpeg } from "../src/render/jpeg";

const png = Buffer.from(new Resvg(
  `<svg xmlns="http://www.w3.org/2000/svg" width="108" height="135"><rect width="108" height="135" fill="#ff0000"/><rect x="54" width="54" height="135" fill="#0000ff"/></svg>`,
).render().asPng());

describe("pngToJpeg (Instagram só aceita JPEG)", () => {
  it("gera um JPEG válido com as mesmas dimensões e as cores preservadas", () => {
    const out = pngToJpeg(png, { width: 108, height: 135 });
    expect(out.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff])); // assinatura JPEG
    const img = jpeg.decode(out);
    expect([img.width, img.height]).toEqual([108, 135]);
    const px = (x: number, y: number) => Array.from(img.data.subarray((y * 108 + x) * 4, (y * 108 + x) * 4 + 3));
    const [r1, , b1] = px(10, 60);
    const [r2, , b2] = px(100, 60);
    expect(r1).toBeGreaterThan(200); expect(b1).toBeLessThan(60);
    expect(b2).toBeGreaterThan(200); expect(r2).toBeLessThan(60);
  });
  it("recusa dimensões absurdas", () => {
    expect(() => pngToJpeg(png, { width: 0, height: 10 })).toThrow();
    expect(() => pngToJpeg(png, { width: 10_000, height: 10 })).toThrow();
  });
});
