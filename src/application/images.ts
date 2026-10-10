import type { LibraryService } from "../services/contracts";

/**
 * Object URLs for managed images (covers and reading backgrounds), created
 * once per asset. Asset ids are never reused, so a replaced cover gets a new
 * URL and the old one is released.
 */
export class ImageLoader {
  private readonly urls = new Map<string, Promise<string>>();

  public constructor(private readonly service: Pick<LibraryService, "readAsset">) {}

  public load(id: string): Promise<string> {
    let pending = this.urls.get(id);
    if (!pending) {
      pending = this.service.readAsset(id).then((bytes) => URL.createObjectURL(new Blob([bytes])));
      pending.catch(() => this.urls.delete(id));
      this.urls.set(id, pending);
    }
    return pending;
  }

  public release(id: string): void {
    const pending = this.urls.get(id);
    this.urls.delete(id);
    void pending?.then((url) => URL.revokeObjectURL(url)).catch(() => undefined);
  }
}
