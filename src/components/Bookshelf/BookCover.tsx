import { useState } from "react";
import { useImage } from "../../application/runtime";

/** Muted paper tones with a matching ink, like a plain cloth-bound book. */
const LOCAL_COVER_PALETTES = [
  { paper: "#ece3d2", ink: "#5b4632" }, // 米白
  { paper: "#d8e2da", ink: "#33503f" }, // 青瓷
  { paper: "#d9e0e8", ink: "#34465a" }, // 雾蓝
  { paper: "#e9d8c6", ink: "#6a4128" }, // 浅赭
  { paper: "#e1dfda", ink: "#3d3d3b" }, // 灰墨
  { paper: "#ede1c0", ink: "#68511f" }, // 杏黄
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
      className="w-full h-full p-[7%] select-none relative overflow-hidden"
      style={{ background: theme.paper, color: theme.ink }}
    >
      {/* A thin inner frame, with a short rule under the title. */}
      <div
        className="w-full h-full rounded-[2px] border flex flex-col items-center justify-center gap-[8%] px-[8%] text-center"
        style={{ borderColor: `${theme.ink}40` }}
      >
        <span className="font-title-editorial font-semibold text-[11px] sm:text-xs leading-snug line-clamp-4 break-all">
          {cleanTitle}
        </span>
        <span className="block h-px w-1/4" style={{ background: `${theme.ink}66` }} />
      </div>
    </div>
  );
}
