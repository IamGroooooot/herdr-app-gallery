export interface ReadState<T> { readonly value: T | null; readonly error: string | null; readonly loading: boolean; readonly checkedAt: number | null }

/** A shared, single-flight read with TTL, last-good data and invalidation. */
export class Resource<T> {
  value: T | null = null;
  error: string | null = null;
  loading = false;
  checkedAt: number | null = null;
  private attemptedAt: number | null = null;
  private pending: Promise<void> | null = null;
  private generation = 0;
  constructor(private readonly read: () => Promise<T>, private readonly clock = Date.now,
    private readonly changed: () => void = () => {}) {}

  refresh(maxAge = 0): Promise<void> {
    if (this.pending) return this.pending;
    if (this.attemptedAt !== null && this.clock() - this.attemptedAt < maxAge) return Promise.resolve();
    this.attemptedAt = this.clock();
    this.loading = true;
    const generation = this.generation;
    this.pending = Promise.resolve().then(this.read).then(value => {
      if (generation !== this.generation) return;
      this.value = value;
      this.error = null;
      this.checkedAt = this.clock();
    }, error => {
      if (generation === this.generation) this.error = error instanceof Error ? error.message : 'Could not refresh.';
    }).finally(() => {
      this.loading = false;
      this.pending = null;
      this.changed();
    });
    this.changed();
    return this.pending;
  }

  invalidate(): void {
    this.generation++;
    this.value = null;
    this.error = null;
    this.checkedAt = null;
    this.attemptedAt = null;
    this.changed();
  }
}
