import Image from "next/image";
import mark from "@/public/brand/iron-mark.png";

/** Símbolo IRON + nome no padrão do Brand Kit: "IRON" em 800, o resto em 500, tracking .1em. */
export function Brand({ href, byline }: { href: string; byline: string }) {
  return (
    <a href={href} className="brand" aria-label="IRON CYBER NEWS">
      <Image src={mark} alt="" className="brand__logo" height={28} priority />
      <span>
        <span className="brand__name"><b>IRON</b> CYBER NEWS</span>
        <span className="brand__by">{byline}</span>
      </span>
    </a>
  );
}
