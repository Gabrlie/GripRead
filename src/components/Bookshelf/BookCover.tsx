import { useState } from "react";
import { useImage } from "../../application/runtime";
import { Icon } from "../ui/Icon";

const LOCAL_COVER_PALETTES = [
  {
    bg: "bg-gradient-to-br from-[#8b3a2b] via-[#6d2517] to-[#451209]",
    badge: "text-[#fcd8d0]",
    text: "text-[#ffede9]",
  }, // 朱砂熟赭
  {
    bg: "bg-gradient-to-br from-[#1e4d3a] via-[#143829] to-[#0a2016]",
    badge: "text-[#c8eedc]",
    text: "text-[#e8f8f0]",
  }, // 竹青碧玉
  {
    bg: "bg-gradient-to-br from-[#244263] via-[#182f48] to-[#0c1a29]",
    badge: "text-[#cfe2f8]",
    text: "text-[#eef5fc]",
  }, // 砚墨霁蓝
  {
    bg: "bg-gradient-to-br from-[#855323] via-[#633a12] to-[#3a1f06]",
    badge: "text-[#fde4c8]",
    text: "text-[#fef4ea]",
  }, // 暖茶琥珀
  {
    bg: "bg-gradient-to-br from-[#53315e] via-[#3d2047] to-[#25102d]",
    badge: "text-[#ebd4f5]",
    text: "text-[#f8f0fc]",
  }, // 绛紫云锦
  {
    bg: "bg-gradient-to-br from-[#3b474e] via-[#2a343a] to-[#161c20]",
    badge: "text-[#d7e3ea]",
    text: "text-[#f0f5f8]",
  }, // 金石苍青
];

function getCoverTheme(title: string) {
  let hash = 0;
  for (let i = 0; i < title.length; i++) {
    hash = (hash * 31 + title.charCodeAt(i)) & 0xffffffff;
  }
  return LOCAL_COVER_PALETTES[Math.abs(hash) % LOCAL_COVER_PALETTES.length];
}

/** The book's own cover image, or a generated cover from its title. */
export function BookCover({ title, assetId }: { title: string; assetId?: string | null }) {
  const coverUrl = useImage(assetId);
  const [hasError, setHasError] = useState(false);
  if (coverUrl && !hasError) {
    return (
      <img
        src={coverUrl}
        alt={title}
        className="w-full h-full object-cover"
        loading="lazy"
        onError={() => setHasError(true)}
      />
    );
  }
  const theme = getCoverTheme(title);
  const cleanTitle = title.replace(/^《|》$/g, "").trim();
  return (
    <div
      aria-hidden="true"
      className={`w-full h-full flex flex-col justify-between p-2 sm:p-2.5 ${theme.bg} shadow-inner select-none relative overflow-hidden border-l-2 border-white/20`}
    >
      <div className="flex items-center justify-between w-full opacity-85">
        <Icon name="auto_stories" size={14} className={theme.badge} />
        <span className={`text-[9px] font-mono font-semibold tracking-wider ${theme.badge}`}>
          TXT
        </span>
      </div>
      <div className="flex flex-col gap-0.5 mt-auto">
        <span
          className={`text-[10px] sm:text-[11px] font-title-editorial font-semibold line-clamp-3 leading-snug tracking-tight ${theme.text}`}
        >
          {cleanTitle}
        </span>
      </div>
    </div>
  );
}
