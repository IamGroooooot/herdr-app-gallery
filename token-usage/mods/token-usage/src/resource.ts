/** Single-flight refresh. A failed read preserves the last successful value. */
export class Resource<T> {
  value: T | null = null;
  error: string | null = null;
  loading = false;
  checkedAt: number | null = null;
  private pending: Promise<void> | null = null;
  constructor(private readonly read: () => Promise<T>, private readonly clock = Date.now) {}
  refresh(): Promise<void> {
    if (this.pending) return this.pending;
    this.loading = true;
    this.pending = Promise.resolve().then(this.read).then(value => {
      this.value = value;
      this.error = null;
      this.checkedAt = this.clock();
    }, error => {
      this.error = error instanceof Error ? error.message : 'Could not refresh.';
    }).finally(() => {
      this.loading = false;
      this.pending = null;
    });
    return this.pending;
  }
}
