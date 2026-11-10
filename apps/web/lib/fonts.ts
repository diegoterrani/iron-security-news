import { IBM_Plex_Mono, Manrope } from "next/font/google";

/**
 * Fontes do Brand Kit: Manrope para ler, IBM Plex Mono para rotular.
 * next/font hospeda os arquivos no próprio site no build (nenhuma requisição ao Google em produção).
 */
export const manrope = Manrope({ subsets: ["latin", "latin-ext"], display: "swap", variable: "--font-manrope", weight: ["400", "500", "600", "700", "800"] });
export const plexMono = IBM_Plex_Mono({ subsets: ["latin", "latin-ext"], display: "swap", variable: "--font-plex-mono", weight: ["400", "500", "600"] });

export const fontVars = `${manrope.variable} ${plexMono.variable}`;
