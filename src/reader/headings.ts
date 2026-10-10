/**
 * Chapter heading positions shared by every renderer of reader text: the
 * measurer, visible pages, continuous scrolling, and page-turn overlays all
 * mark the same lines, so heading styles paginate exactly as they display.
 */
export class HeadingIndex {
  private readonly offsets: readonly number[];

  /** `offsets` are absolute UTF-16 positions of heading line starts. */
  public constructor(offsets: Iterable<number> = []) {
    this.offsets = [...new Set(offsets)].sort((left, right) => left - right);
  }

  public get size(): number {
    return this.offsets.length;
  }

  /** Heading starts inside `[start, end)`, relative to `start`. */
  public local(start: number, end: number): ReadonlySet<number> {
    const result = new Set<number>();
    let low = 0;
    let high = this.offsets.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (this.offsets[middle] < start) low = middle + 1;
      else high = middle;
    }
    for (let index = low; index < this.offsets.length && this.offsets[index] < end; index += 1)
      result.add(this.offsets[index] - start);
    return result;
  }

  /** A short identity for layout invalidation. */
  public signature(): string {
    return `${this.offsets.length}:${this.offsets[0] ?? ""}:${this.offsets.at(-1) ?? ""}`;
  }
}

export const NO_HEADINGS = new HeadingIndex();
