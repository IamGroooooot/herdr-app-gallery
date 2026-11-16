// Generated from src/resource.ts. Edit the TS source, then run npm run verify.
export class Resource {
    read;
    clock;
    changed;
    value = null;
    error = null;
    loading = false;
    checkedAt = null;
    attemptedAt = null;
    pending = null;
    generation = 0;
    constructor(read, clock = Date.now, changed = () => { }) {
        this.read = read;
        this.clock = clock;
        this.changed = changed;
    }
    refresh(maxAge = 0) {
        if (this.pending)
            return this.pending;
        if (this.attemptedAt !== null && this.clock() - this.attemptedAt < maxAge)
            return Promise.resolve();
        this.attemptedAt = this.clock();
        this.loading = true;
        const generation = this.generation;
        this.pending = Promise.resolve()
            .then(this.read)
            .then(value => {
            if (generation !== this.generation)
                return;
            this.value = value;
            this.error = null;
            this.checkedAt = this.clock();
        }, error => {
            if (generation === this.generation)
                this.error = error instanceof Error ? error.message : 'Could not refresh.';
        })
            .finally(() => {
            this.loading = false;
            this.pending = null;
            this.changed();
        });
        this.changed();
        return this.pending;
    }
    invalidate() {
        this.generation++;
        this.value = null;
        this.error = null;
        this.checkedAt = null;
        this.attemptedAt = null;
        this.changed();
    }
}
