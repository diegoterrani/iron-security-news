/** O site só pede indexação aos buscadores depois do lançamento oficial (SITE_INDEXABLE=1 na Vercel). */
export const indexable = () => process.env.SITE_INDEXABLE === "1";
