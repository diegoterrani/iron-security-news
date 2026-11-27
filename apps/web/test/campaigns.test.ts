import { describe, expect, it } from "vitest";
import {
  DESTINATIONS, captionLength, linkedinCaptionLength, MEDIA_PATH_RE, brasiliaToIso, checkFiles, destinationLabel, isDestinationKey, storageName,
} from "../lib/admin/campaigns";

const MB = 1024 * 1024;

describe("campanhas: arquivos", () => {
  it("nome no Storage: posição, sem acento nem espaço, extensão minúscula, e casa com a policy", () => {
    const name = storageName(0, "Dia 02 · Carrossel LinkedIn (final).PDF");
    expect(name).toBe("01-dia-02-carrossel-linkedin-final.pdf");
    expect(MEDIA_PATH_RE.test(`campanhas/0b6f4c1e-1111-4a2b-9c3d-123456789abc/${name}`)).toBe(true);
    expect(storageName(9, "###.jpg")).toBe("10-arquivo.jpg");
  });
  it("confere quantidade, extensão e tamanho por destino", () => {
    expect(checkFiles(DESTINATIONS.ig_reel, [{ name: "a.mp4", size: 17 * MB }])).toBeNull();
    expect(checkFiles(DESTINATIONS.ig_reel, [{ name: "a.mov", size: MB }])).toMatch(/\.mp4/);
    expect(checkFiles(DESTINATIONS.ig_carousel, [{ name: "a.jpg", size: MB }])).toMatch(/2 a 10/);
    expect(checkFiles(DESTINATIONS.ig_carousel, [{ name: "a.jpg", size: MB }, { name: "b.png", size: 9 * MB }])).toMatch(/8 MB/);
    expect(checkFiles(DESTINATIONS.li_member_document, [{ name: "c.pdf", size: 400_000 }])).toBeNull();
  });
  it("só aceita caminhos dentro de campanhas/<uuid>/", () => {
    expect(MEDIA_PATH_RE.test("campanhas/../x.pdf")).toBe(false);
    expect(MEDIA_PATH_RE.test("stories/0b6f4c1e-1111-4a2b-9c3d-123456789abc/a.pdf")).toBe(false);
  });
});

describe("campanhas: horário e rótulos", () => {
  it("converte o horário de Brasília para UTC", () => {
    expect(brasiliaToIso("2026-11-27T12:00")).toBe("2026-11-27T15:00:00.000Z");
    expect(brasiliaToIso("27/11/2026 12:00")).toBeNull();
    expect(brasiliaToIso("2026-13-40T99:00")).toBeNull();
  });
  it("destinos e rótulos", () => {
    expect(isDestinationKey("li_org_document")).toBe(true);
    expect(isDestinationKey("constructor")).toBe(false);
    expect(destinationLabel("linkedin", "organization", "document")).toBe("LinkedIn página IRON · Carrossel PDF");
  });
});

describe("campanhas: tamanho da legenda no LinkedIn", () => {
  it("conta o escape e o template de hashtag, igual ao executor", () => {
    // Executor: "Agende \\(7 dias\\): iron.com/a\\_b\n\n{hashtag|\\#|Cibersegurança} {hashtag|\\#|CISO}"
    const expected = "Agende \\(7 dias\\): iron.com/a\\_b\n\n{hashtag|\\#|Cibersegurança} {hashtag|\\#|CISO}".length;
    expect(linkedinCaptionLength("Agende (7 dias): iron.com/a_b\n\n#Cibersegurança #CISO")).toBe(expected);
    expect(linkedinCaptionLength("C#")).toBe(3);
    expect(linkedinCaptionLength("Plantão #3")).toBe("Plantão \\#3".length);
  });
  it("3.000 caracteres crus com hashtags passam do limite no LinkedIn, mas não no Instagram", () => {
    const text = `${"a".repeat(2990)} #CISO`;
    expect(captionLength(DESTINATIONS.li_member_video, text)).toBeGreaterThan(3000);
    expect(captionLength(DESTINATIONS.ig_reel, text)).toBe(2996);
  });
});
