/** In-memory historian: fixed-rate samples of selected signals, ring-buffered. */

export class Historian<K extends string> {
  readonly t: number[] = [];
  readonly series: Record<K, number[]>;

  constructor(
    keys: readonly K[],
    private readonly capacity = 3000,
  ) {
    this.series = Object.fromEntries(keys.map((k) => [k, [] as number[]])) as Record<K, number[]>;
  }

  sample(ts: number, values: Record<K, number>): void {
    this.t.push(ts / 1000);
    for (const k in this.series) this.series[k].push(values[k]);
    if (this.t.length > this.capacity) {
      this.t.shift();
      for (const k in this.series) this.series[k].shift();
    }
  }

  /** Columns for the last `seconds`, in uPlot's aligned-data layout. */
  window(seconds: number, keys: K[]): number[][] {
    const end = this.t.length;
    const tEnd = end ? this.t[end - 1] : 0;
    let start = end;
    while (start > 0 && tEnd - this.t[start - 1] <= seconds) start--;
    return [this.t.slice(start, end), ...keys.map((k) => this.series[k].slice(start, end))];
  }
}
