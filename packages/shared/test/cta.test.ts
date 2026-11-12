import { describe, expect, it } from "vitest";
import { socialCta, socialPostText, stripOldInvite } from "../src/cta";

describe("CTA padrão das redes", () => {
  it("Instagram/Facebook usam 'Link na Bio'; LinkedIn/Shorts usam os links", () => {
    expect(socialCta("instagram", "pt")).toContain("Leia o artigo completo no blog Iron Cyber News - Link na Bio.");
    expect(socialCta("facebook", "pt")).toContain("FORMAÇÃO SOC N1 - Link na Bio.");
    expect(socialCta("linkedin", "pt")).toContain("https://news.iron-security.com/");
    expect(socialCta("youtube", "pt")).toContain("https://www.iron-security.com/academy/soc-n1");
    expect(socialCta("instagram", "en")).toContain("Link in Bio");
  });

  it("monta texto + CTA + hashtags, sem duplicar o convite antigo", () => {
    const out = socialPostText("instagram", "pt", {
      caption: "Falha crítica no OpenSSH. Atualize já. Leia o artigo completo, link na bio.",
      hashtags: ["#OpenSSH", "#Linux"],
    });
    expect(out.match(/link na bio/gi)).toHaveLength(2); // só as duas do CTA padrão
    expect(out.startsWith("Falha crítica no OpenSSH. Atualize já.")).toBe(true);
    expect(out.endsWith("#OpenSSH #Linux")).toBe(true);
  });

  it("Short: CTA vai na descrição; Facebook sem hashtags", () => {
    expect(socialPostText("youtube", "pt", { description: "Resumo.", script: "roteiro" })).toMatch(/^Resumo\.\n\nQuer entender/);
    expect(socialPostText("facebook", "pt", { text: "Texto.", hashtags: ["#x"] })).not.toContain("#x");
  });

  it("stripOldInvite mantém texto sem convite", () => {
    expect(stripOldInvite("Atualize o servidor. Restrinja o acesso.")).toBe("Atualize o servidor. Restrinja o acesso.");
    expect(stripOldInvite("Patch disponível.\n\nMore details on the Iron Cyber News blog.")).toBe("Patch disponível.");
  });

  it("remove os convites reais das stories já aprovadas", () => {
    const cases: [string, string][] = [
      ["Priorize inventário e verificação de comprometimento. link na bio", "Priorize inventário e verificação de comprometimento."],
      ["Verifique agora.\n\nQuer entender o caso completo e as ações recomendadas? Leia o artigo completo no blog Iron Cyber News.", "Verifique agora."],
      ["Confirme as versões.\n\nQuer ver o que fazer agora e os detalhes de cada falha? Leia o artigo completo no link a seguir.", "Confirme as versões."],
      ["Patch early.\n\nWant the full breakdown, including CVSS scores and the steps to take now? Read the complete article below.", "Patch early."],
      ["Comece pelo inventário. Leia o artigo completo para entender os próximos passos.", "Comece pelo inventário."],
      ["3. Confirm every endpoint.\n\nRead the full analysis on the Iron Cyber News blog.", "3. Confirm every endpoint."],
      ["Reduza a janela de exposição.\n\n#Ciberseguranca #OpenSSH #GestaoDeRisco", "Reduza a janela de exposição."],
      ["Veja as ações recomendadas. Leia mais no blog Iron Cyber News.", "Veja as ações recomendadas."],
      ["Review authentication logs. Full details on the Iron Cyber News blog.", "Review authentication logs."],
    ];
    for (const [input, want] of cases) expect(stripOldInvite(input)).toBe(want);
  });
});
