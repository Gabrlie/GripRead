import type { SettingsService } from "../services/contracts";

/**
 * Loads managed reading fonts into the document once each. A font that the
 * browser cannot decode rejects, so the reader keeps its previous font and
 * reports the failure instead of silently falling back.
 */
export class FontLoader {
  private readonly loaded = new Map<string, Promise<string>>();

  public constructor(private readonly service: Pick<SettingsService, "readFont">) {}

  /** Resolves with the CSS family name registered for the font. */
  public load(id: string): Promise<string> {
    let pending = this.loaded.get(id);
    if (!pending) {
      const family = `GripRead Font ${id}`;
      pending = this.service
        .readFont(id)
        .then((bytes) => new FontFace(family, bytes).load())
        .then((face) => {
          document.fonts.add(face);
          return family;
        });
      // A failed load may succeed after the file is replaced; do not cache it.
      pending.catch(() => this.loaded.delete(id));
      this.loaded.set(id, pending);
    }
    return pending;
  }
}
