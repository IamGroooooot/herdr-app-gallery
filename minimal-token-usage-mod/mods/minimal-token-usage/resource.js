// Generated from src/resource.ts. Edit the TS source, then run npm run verify.
export class Resource {
    read;
    clock;
    changed;
    deadline;
    value = null;
    error = null;
    loading = false;
    checkedAt = null;
    attemptedAt = null;
    pending = null;
    generation = 0;
    constructor(read, clock = Date.now, changed = () => { }, deadline = 30000) {
        this.read = read;
        this.clock = clock;
        this.changed = changed;
        this.deadline = deadline;
    }
    /** A read the host never answers must not hold the resource in "loading" forever: past `deadline` it fails and the next refresh asks again. */
    refresh(maxAge = 0) {
        if (this.pending) {
            if (this.clock() - (this.attemptedAt ?? 0) < this.deadline)
                return this.pending;
            this.abandon('Timed out.');
            this.attemptedAt = null;
        }
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
            if (generation !== this.generation)
                return;
            this.loading = false;
            this.pending = null;
            this.changed();
        });
        this.changed();
        return this.pending;
    }
    abandon(error) {
        this.generation++;
        this.pending = null;
        this.loading = false;
        this.error = error;
    }
    invalidate() {
        this.abandon(null);
        this.value = null;
        this.checkedAt = null;
        this.attemptedAt = null;
        this.changed();
    }
}
