import Image from "next/image";
import shield from "@/public/iron-shield.png";

export function Brand({ href, byline }: { href: string; byline: string }) {
  return (
    <a href={href} className="brand" aria-label="IRON CYBER NEWS">
      <Image src={shield} alt="" className="brand__logo" height={32} priority />
      <span>
        <span className="brand__name">IRON CYBER NEWS</span>
        <span className="brand__by">{byline}</span>
      </span>
    </a>
  );
}
