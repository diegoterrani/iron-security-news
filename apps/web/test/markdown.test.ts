import { describe, expect, it } from "vitest";
import { withoutTldrSection } from "../lib/markdown";

describe("withoutTldrSection", () => {
  it("remove só a seção TL;DR, mantendo as demais", () => {
    const md = "## TL;DR\nResumo.\n\n## O que aconteceu\nFato.\n\n## Impacto\nX.";
    expect(withoutTldrSection(md)).toBe("## O que aconteceu\nFato.\n\n## Impacto\nX.");
  });
  it("aceita variações e não mexe quando não há a seção", () => {
    expect(withoutTldrSection("## TLDR\na\n## What happened\nb")).toBe("## What happened\nb");
    expect(withoutTldrSection("## O que aconteceu\nFato.")).toBe("## O que aconteceu\nFato.");
  });
});
