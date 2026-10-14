import { useEffect, useMemo, useRef } from "react";
import type { FeedService } from "../../services/contracts";
import { openExternal } from "../../services/external";

/** Remote pictures wait for the app to fetch them (offline copies, referrers). */
function deferImages(html: string): string {
  return html.replace(/<img src="/g, '<img data-rss-src="');
}

/**
 * An article's sanitized HTML (cleaned by the core when stored): pictures
 * come through the app's cache, and links open in the browser.
 */
export function ArticleContent({
  html,
  referer,
  service,
  fontSize,
}: {
  html: string;
  referer: string | null;
  service: FeedService;
  fontSize: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  const markup = useMemo(() => ({ __html: deferImages(html) }), [html]);
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    let active = true;
    const urls: string[] = [];
    for (const image of element.querySelectorAll<HTMLImageElement>("img[data-rss-src]")) {
      const source = image.dataset.rssSrc!;
      image.loading = "lazy";
      void service.image(source, referer).then(
        (bytes) => {
          if (!active || bytes.byteLength === 0) return;
          const url = URL.createObjectURL(new Blob([bytes]));
          urls.push(url);
          image.src = url;
        },
        () => image.classList.add("rss-image-failed"),
      );
    }
    return () => {
      active = false;
      urls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [markup, referer, service]);
  return (
    <div
      ref={box}
      data-selectable="true"
      className="rss-article"
      style={{ fontSize }}
      onClick={(event) => {
        const link = (event.target as HTMLElement).closest("a");
        if (!link) return;
        event.preventDefault();
        const href = link.getAttribute("href");
        if (href) void openExternal(href).catch(() => undefined);
      }}
      dangerouslySetInnerHTML={markup}
    />
  );
}
