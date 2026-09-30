/** Height index for a virtual code block. Updates and offset lookup are O(log line count). */
export class CodeLineHeights {
  private readonly heights: Float64Array;
  private readonly tree: Float64Array;
  constructor(readonly count: number, estimate: number, initial?: (index: number) => number) {
    this.heights = new Float64Array(count).fill(estimate);
    this.tree = new Float64Array(count + 1);
    for (let index = 1; index <= count; index++) {
      if (initial) this.heights[index - 1] = initial(index - 1);
      this.tree[index]! += this.heights[index - 1]!;
      const parent = index + (index & -index);
      if (parent <= count) this.tree[parent]! += this.tree[index]!;
    }
  }
  height(index: number): number { return this.heights[index] ?? 0; }
  set(index: number, height: number): void {
    if (index < 0 || index >= this.count || !Number.isFinite(height) || height <= 0) return;
    const delta = height - this.heights[index]!;
    this.heights[index] = height;
    for (let cursor = index + 1; cursor <= this.count; cursor += cursor & -cursor) this.tree[cursor]! += delta;
  }
  offset(end: number): number {
    let sum = 0;
    for (let cursor = Math.min(this.count, Math.max(0, end)); cursor > 0; cursor -= cursor & -cursor) sum += this.tree[cursor]!;
    return sum;
  }
  indexAt(offset: number): number {
    let index = 0;
    let sum = 0;
    let bit = 1;
    while (bit * 2 <= this.count) bit *= 2;
    for (; bit > 0; bit >>= 1) {
      const next = index + bit;
      if (next <= this.count && sum + this.tree[next]! <= offset) { index = next; sum += this.tree[next]!; }
    }
    return Math.min(Math.max(0, this.count - 1), index);
  }
}

export function codeLineWindow(heights: CodeLineHeights, scrollTop: number, viewport: number) {
  const start = Math.max(0, heights.indexAt(Math.max(0, scrollTop)) - 8);
  const end = Math.min(heights.count, Math.max(start + 1, heights.indexAt(Math.max(0, scrollTop) + viewport) + 9));
  return { start, end, before: heights.offset(start), after: heights.offset(heights.count) - heights.offset(end) };
}

/** Resize/wrap changes keep the top logical line and relative position within a long wrapped line. */
export function codeLineAnchor(heights: CodeLineHeights, scrollTop: number) {
  const index = heights.indexAt(Math.max(0, scrollTop));
  return { index, fraction: Math.min(1, Math.max(0, (scrollTop - heights.offset(index)) / Math.max(1, heights.height(index)))) };
}
export function codeLineAnchorOffset(heights: CodeLineHeights, anchor: { index: number; fraction: number }): number {
  return heights.offset(anchor.index) + Math.min(Math.max(0, heights.height(anchor.index) - 0.1), heights.height(anchor.index) * anchor.fraction);
}

/** Content growth retains the already-read prefix, rather than moving with the line's new height. */
export function codeLineReadingAnchor(heights: CodeLineHeights, scrollTop: number) {
  const index = heights.indexAt(Math.max(0, scrollTop));
  return { index, offset: Math.max(0, scrollTop - heights.offset(index)) };
}
export function codeLineReadingAnchorOffset(heights: CodeLineHeights, anchor: { index: number; offset: number }): number {
  const index = Math.min(Math.max(0, heights.count - 1), Math.max(0, anchor.index));
  return heights.offset(index) + Math.min(Math.max(0, heights.height(index) - 0.1), Math.max(0, anchor.offset));
}

/** Never re-observe unchanged rows: ResizeObserver sends an initial notification on observe(). */
export function syncCodeLineObservers<T>(
  observer: { observe(row: T): void; unobserve(row: T): void } | undefined,
  previous: Set<T>, current: ReadonlySet<T>
): void {
  for (const row of previous) {
    if (!current.has(row)) { observer?.unobserve(row); previous.delete(row); }
  }
  for (const row of current) {
    if (!previous.has(row)) { observer?.observe(row); previous.add(row); }
  }
}

/** Conservative monospace width: tabs are two columns; non-ASCII glyphs may occupy two. */
export function codeLineColumns(line: string): number {
  if (!/[^\x00-\x7f]|\t/.test(line)) return line.length;
  let columns = 0;
  for (const character of line) columns += character === '\t' || character.codePointAt(0)! > 0x7f ? 2 : 1;
  return columns;
}
