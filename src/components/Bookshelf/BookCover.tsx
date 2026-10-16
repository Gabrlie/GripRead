import { useState } from "react";
import { useImage, useOptionalImage, useOptionalPreferences } from "../../application/runtime";
import type { ReaderPreferences } from "../../types/generated";

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
export function BookCover({
  title,
  author,
  assetId,
}: {
  title: string;
  author?: string | null;
  assetId?: string | null;
}) {
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
  return <GeneratedCover title={title} author={author} />;
}

/** Whether the night colours are in use now. */
function nightNow(preferences: ReaderPreferences | null): boolean {
  if (!preferences) return false;
  if (preferences.theme === "dark") return true;
  if (preferences.theme === "light") return false;
  return (
    typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches
  );
}

/**
 * The cover drawn for a book without one: 默认封面's image for day or night
 * when one is chosen (外观), else one made from the title, with the title
 * and author shown as 外观 says.
 */
export function GeneratedCover({ title, author }: { title: string; author?: string | null }) {
  const preferences = useOptionalPreferences();
  const night = nightNow(preferences);
  const image = useOptionalImage(
    night
      ? (preferences?.nightDefaultCover ?? preferences?.defaultCover)
      : preferences?.defaultCover,
  );
  const showName = preferences?.coverShowName ?? true;
  const showAuthor = preferences?.coverShowAuthor ?? true;
  const theme = getCoverTheme(title);
  const cleanTitle = title.replace(/^《|》$/g, "").trim();
  const words = (
    <>
      {showName && (
        <span
          className="font-title-editorial font-semibold leading-snug line-clamp-5 break-all"
          style={{ fontSize: "clamp(6px, 14cqw, 15px)" }}
        >
          {cleanTitle}
        </span>
      )}
      {showAuthor && author && (
        <span
          className="leading-snug line-clamp-2 break-all opacity-80"
          style={{ fontSize: "clamp(5px, 9cqw, 11px)" }}
        >
          {author}
        </span>
      )}
    </>
  );
  if (image)
    return (
      <div
        aria-hidden="true"
        className="w-full h-full relative overflow-hidden select-none"
        style={{ containerType: "inline-size" }}
      >
        <img src={image} alt="" className="w-full h-full object-cover" />
        {(showName || (showAuthor && author)) && (
          <div className="absolute inset-x-0 top-[18%] flex flex-col items-center gap-[6%] px-[10%] text-center text-white [text-shadow:0_1px_3px_rgb(0_0_0/0.6)]">
            {words}
          </div>
        )}
      </div>
    );
  return (
    <div
      aria-hidden="true"
      className="w-full h-full p-[7%] select-none relative overflow-hidden"
      // The title is sized from the cover's own width, so small covers in
      // lists and records still show it whole (about five characters a line).
      style={{ background: theme.paper, color: theme.ink, containerType: "inline-size" }}
    >
      {/* A thin inner frame, with a short rule under the title. */}
      <div
        className="w-full h-full rounded-[2px] border flex flex-col items-center justify-center gap-[8%] px-[8%] text-center"
        style={{ borderColor: `${theme.ink}40` }}
      >
        {words}
        <span className="block h-px w-1/4" style={{ background: `${theme.ink}66` }} />
      </div>
    </div>
  );
}
