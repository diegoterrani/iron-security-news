import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { ZodType } from "zod";

/**
 * Saída estruturada só com o JSON Schema, sem a função `parse` do helper.
 * Com o `parse`, `stream().finalMessage()` valida contra o Zod e LANÇA exceção quando o modelo
 * passa de um limite (ex.: título com 72 caracteres), antes de o nosso código poder normalizar
 * a saída ou tratá-la como problema para a próxima tentativa. A validação fica no nosso código.
 */
export function jsonSchemaFormat(schema: ZodType): { type: "json_schema"; schema: Record<string, unknown> } {
  const f = zodOutputFormat(schema);
  return { type: "json_schema", schema: f.schema as Record<string, unknown> };
}
