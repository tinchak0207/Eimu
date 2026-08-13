import Image from "next/image";

type VendorIconProps = {
  vendor: string;
  className?: string;
  innerClassName?: string;
};

const OPENAI_PATH =
  "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z";

const FLUX_PATH =
  "M11.402 23.747q.231.112.454.238c.181.038.37.004.525-.097l.386-.251c-1.242-.831-2.622-1.251-3.998-1.602zm-7.495-5.783a8 8 0 0 1-.222-.236a.696.696 0 0 0 .112 1.075l2.304 1.498c1.019.422 2.085.686 3.134.944c1.636.403 3.2.79 4.554 1.728l.697-.453c-1.541-1.158-3.327-1.602-5.065-2.03c-2.039-.503-3.965-.977-5.514-2.526m1.414-1.322l-.665.432q.033.037.068.073c1.702 1.702 3.825 2.225 5.877 2.731c1.778.438 3.469.856 4.9 1.982l.682-.444c-1.612-1.357-3.532-1.834-5.395-2.293c-2.019-.497-3.926-.969-5.467-2.481m7.502 2.084c1.596.412 3.096.904 4.367 2.036l.67-.436c-1.484-1.396-3.266-1.953-5.037-2.403zm.698-2.337l-.698-.174v.802l.512.127c2.039.503 3.965.978 5.514 2.526l.007.009l.663-.431l-.121-.128c-1.702-1.701-3.824-2.225-5.877-2.731m-.698-1.928v.816c.624.19 1.255.347 1.879.501c2.039.502 3.965.977 5.513 2.526q.116.116.226.239a.704.704 0 0 0-.238-.911l-3.064-1.992c-.744-.245-1.502-.433-2.251-.618a31 31 0 0 1-2.065-.561m-1.646 3.049c-1.526-.4-2.96-.888-4.185-1.955l-.674.439c1.439 1.326 3.151 1.88 4.859 2.319zm0-1.772a8.5 8.5 0 0 1-2.492-1.283l-.686.446c.975.804 2.061 1.293 3.178 1.655zm0-1.946a8 8 0 0 1-.776-.453l-.701.456c.462.337.957.627 1.477.865zm3.533.269l-1.887-1.226v.581q.922.386 1.887.645m5.493-8.863L12.381.112a.7.7 0 0 0-.762 0L3.797 5.198a.698.698 0 0 0 0 1.171l7.38 4.797V7.678a.414.414 0 0 0-.412-.412h-.543a.413.413 0 0 1-.356-.617l1.777-3.079a.412.412 0 0 1 .714 0l1.777 3.079a.413.413 0 0 1-.356.617h-.543a.414.414 0 0 0-.412.412v3.488l7.38-4.797a.7.7 0 0 0 0-1.171";

const INLINE_VENDORS: Record<string, string> = {
  OpenAI: OPENAI_PATH,
  FLUX: FLUX_PATH,
};

const IMAGE_VENDORS: Record<string, string> = {
  PixAI: "/brands/pixai.png",
  Google: "/brands/google.png",
  Adobe: "/brands/firefly.png",
  Kling: "/brands/kling.png",
  Dreamina: "/brands/dreamina.png",
  Luma: "/brands/luma.png",
  Runway: "/brands/runway.png",
  SenseNova: "/brands/sensetime.png",
};

const BRAND_BG: Record<string, string> = {
  PixAI: "rgba(236,72,153,0.14)",
  OpenAI: "#0A0A0A",
  Google: "#FFFFFF",
  Kling: "#FFFFFF",
  Adobe: "#FFFFFF",
  Dreamina: "#FFFFFF",
  Runway: "#1F2937",
  FLUX: "#FFFFFF",
  Luma: "#FFFFFF",
  SenseNova: "#C8102E",
};

export function VendorIcon({ vendor, className = "h-7 w-7", innerClassName }: VendorIconProps) {
  const path = INLINE_VENDORS[vendor];
  const src = IMAGE_VENDORS[vendor];
  const bg = BRAND_BG[vendor];

  const containerStyle = bg
    ? { backgroundColor: bg }
    : { backgroundColor: "rgba(0,0,0,0.06)" };

  if (path) {
    return (
      <span
        className={`${className} flex shrink-0 items-center justify-center rounded-[0.55rem]`}
        style={containerStyle}
      >
        <svg viewBox="0 0 24 24" className={innerClassName ?? "h-4 w-4"} fill={vendor === "OpenAI" ? "#fff" : "currentColor"} aria-hidden>
          <path d={path} />
        </svg>
      </span>
    );
  }

  if (src) {
    return (
      <span
        className={`${className} flex shrink-0 items-center justify-center overflow-hidden rounded-[0.55rem]`}
        style={containerStyle}
      >
        <Image
          src={src}
          alt={`${vendor} logo`}
          width={28}
          height={28}
          className={`${innerClassName ?? "h-6 w-6"} object-contain`}
        />
      </span>
    );
  }

  return null;
}
