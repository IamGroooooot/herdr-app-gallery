export interface ReadState<T> {
  readonly value: T | null;
  readonly error: string | null;
  readonly loading: boolean;
  readonly checkedAt: number | null;
}

export class Resource<T> {
  value: T | null = null;
  error: string | null = null;
  loading = false;
  checkedAt: number | null = null;
  private attemptedAt: number | null = null;
  private pending: Promise<void> | null = null;
  private generation = 0;
  constructor(
    private readonly read: () => Promise<T>,
    private readonly clock = Date.now,
    private readonly changed: () => void = () => {},
    private readonly deadline = 30000,
  ) {}

  /** A read the host never answers must not hold the resource in "loading" forever: past `deadline` it fails and the next refresh asks again. */
  refresh(maxAge = 0): Promise<void> {
    if (this.pending) {
      if (this.clock() - (this.attemptedAt ?? 0) < this.deadline) return this.pending;
      this.abandon('Timed out.');
      this.attemptedAt = null;
    }
    if (this.attemptedAt !== null && this.clock() - this.attemptedAt < maxAge) return Promise.resolve();
    this.attemptedAt = this.clock();
    this.loading = true;
    const generation = this.generation;
    this.pending = Promise.resolve()
      .then(this.read)
      .then(
        value => {
          if (generation !== this.generation) return;
          this.value = value;
          this.error = null;
          this.checkedAt = this.clock();
        },
        error => {
          if (generation === this.generation)
            this.error = error instanceof Error ? error.message : 'Could not refresh.';
        },
      )
      .finally(() => {
        if (generation !== this.generation) return;
        this.loading = false;
        this.pending = null;
        this.changed();
      });
    this.changed();
    return this.pending;
  }

  private abandon(error: string | null): void {
    this.generation++;
    this.pending = null;
    this.loading = false;
    this.error = error;
  }

  invalidate(): void {
    this.abandon(null);
    this.value = null;
    this.checkedAt = null;
    this.attemptedAt = null;
    this.changed();
  }
}
