// Regenera src/mark.ts a partir de assets/iron-mark.png.
import { readFileSync, writeFileSync } from "node:fs";
const b = readFileSync(new URL("../assets/iron-mark.png", import.meta.url)).toString("base64");
const body = b.match(/.{1,120}/g).map((l) => `  "${l}"`).join(" +\n");
writeFileSync(new URL("../src/mark.ts", import.meta.url), `// Gerado de assets/iron-mark.png (símbolo do Brand Kit, recortado). Não editar à mão:\n// regenere com \`pnpm --filter @ironnews/templates gen:mark\` se o logo mudar.\nexport const IRON_MARK_PNG_BASE64 =\n${body};\n\nexport const IRON_MARK_DATA_URI = \`data:image/png;base64,\${IRON_MARK_PNG_BASE64}\`;\n`);
