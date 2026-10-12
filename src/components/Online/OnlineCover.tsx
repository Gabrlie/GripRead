import { useEffect, useRef, useState } from "react";
import type { SourceService } from "../../services/contracts";
import { useOnlineCover } from "../../application/online";
import { GeneratedCover } from "../Bookshelf/BookCover";

/**
 * A source's cover image, or the generated cover while it loads or when it
 * cannot. A cover is fetched once it is near the screen, so long lists ask
 * for the visible covers first.
 */
export function OnlineCover({
  service,
  sourceUrl,
  url,
  title,
}: {
  service: SourceService;
  sourceUrl: string;
  url: string;
  title: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (visible || !box.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "300px" },
    );
    observer.observe(box.current);
    return () => observer.disconnect();
  }, [visible]);
  const image = useOnlineCover(service, sourceUrl, url, visible);
  const [broken, setBroken] = useState<string | null>(null);
  return (
    <div ref={box} className="w-full h-full">
      {image && broken !== image ? (
        // A source can answer with something that is not an image.
        <img
          src={image}
          alt={title}
          className="w-full h-full object-cover"
          onError={() => setBroken(image)}
        />
      ) : (
        <GeneratedCover title={title} />
      )}
    </div>
  );
}
