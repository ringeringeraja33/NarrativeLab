/** Serialize refreshes and retain one trailing pass for requests arriving during IO. */
export class CoalescedTask {
    private pending = false;
    private running: Promise<void> | null = null;

    constructor(private work: () => Promise<void>) {}

    request(): Promise<void> {
        this.pending = true;
        if (!this.running) {
            // Coalesce calls from the same event before starting IO.
            this.running = Promise.resolve().then(async () => {
                try {
                    while (this.pending) {
                        this.pending = false;
                        await this.work();
                    }
                } finally {
                    this.running = null;
                }
            });
        }
        return this.running;
    }
}
