import { describe, expect, it } from "vitest";
import { parseRansomwareLive } from "../src/ingest/fetchers/ransomware";

const now = new Date("2026-11-12T12:00:00Z");
const v = (over: Record<string, unknown>) => ({
  victim: "Empresa Secreta SA", domain: "empresa-secreta.com.br", description: "dados vazados da Empresa Secreta",
  country: "BR", group: "akira", activity: "Healthcare", discovered: "2026-11-11 10:00:00.000000", ...over,
});

describe("parseRansomwareLive (resumo agregado, sem vítimas)", () => {
  const json = JSON.stringify([
    v({}),
    v({ group: "akira", activity: "Finance", discovered: "2026-11-12 09:00:00" }),
    v({ group: "qilin", activity: "Healthcare", discovered: "2026-11-08 09:00:00" }),
    v({ country: "US", group: "lockbit" }),                         // outro país
    v({ discovered: "2026-10-01 09:00:00" }),                       // fora da janela de 7 dias
    v({ group: "<script>x</script>", activity: "Not Found", discovered: "2026-11-10 09:00:00" }),
  ]);

  it("conta só o país e a janela, com grupos e setores, e NUNCA nomes, domínios ou descrições de vítimas", () => {
    const [item, ...rest] = parseRansomwareLive(json, { country: "BR" }, { now });
    expect(rest).toHaveLength(0);
    expect(item!.title).toBe("Ransomware no Brasil: 4 vítimas divulgadas em 7 dias, akira lidera");
    expect(item!.excerpt).toContain("4 nos últimos 7 dias, 1 nas últimas 24 horas");
    expect(item!.excerpt).toContain("Grupos mais ativos: akira (2), qilin (1), scriptx/script (1)");
    expect(item!.excerpt).toContain("Setores mais atingidos: Healthcare (2), Finance (1)");
    const all = JSON.stringify(item);
    for (const secret of ["Empresa Secreta", "empresa-secreta", "dados vazados", "<script>"]) expect(all).not.toContain(secret);
    expect(item!.flags).toEqual({ brazil: true });
    expect(item!.url).toBe("https://www.ransomware.live/?pais=BR&dia=2026-11-12");
  });
  it("uma URL por dia (dedup) e nada quando não há vítimas suficientes", () => {
    expect(parseRansomwareLive(json, { country: "BR" }, { now: new Date("2026-11-13T12:00:00Z") })[0]!.url).toMatch(/dia=2026-11-13$/);
    expect(parseRansomwareLive(json, { country: "BR", min_victims: 10 }, { now })).toEqual([]);
    expect(parseRansomwareLive("[]", {}, { now })).toEqual([]);
  });
  it("aceita o formato { victims: [...] } e recusa formato desconhecido", () => {
    expect(parseRansomwareLive(JSON.stringify({ victims: [v({})] }), {}, { now })).toHaveLength(1);
    expect(() => parseRansomwareLive("{\"x\":1}", {}, { now })).toThrow(/formato/);
  });
});
