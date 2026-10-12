import { useState } from "react";
import type { SourceService } from "../../services/contracts";
import { useOnlineCover } from "../../application/online";
import { GeneratedCover } from "../Bookshelf/BookCover";

/** A source's cover image, or the generated cover while it loads or when it cannot. */
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
  const image = useOnlineCover(service, sourceUrl, url);
  const [broken, setBroken] = useState<string | null>(null);
  // A source can answer with something that is not an image.
  if (image && broken !== image)
    return (
      <img
        src={image}
        alt={title}
        className="w-full h-full object-cover"
        onError={() => setBroken(image)}
      />
    );
  return <GeneratedCover title={title} />;
}
