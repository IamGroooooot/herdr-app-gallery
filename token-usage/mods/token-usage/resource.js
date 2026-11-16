// Generated from src/resource.ts. Edit the TS source, then run npm run verify.
/** Single-flight refresh. A failed read preserves the last successful value. */
export class Resource {
    read;
    clock;
    value = null;
    error = null;
    loading = false;
    checkedAt = null;
    pending = null;
    constructor(read, clock = Date.now) {
        this.read = read;
        this.clock = clock;
    }
    refresh() {
        if (this.pending)
            return this.pending;
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
