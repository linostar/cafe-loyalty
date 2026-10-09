import type { FastifyBaseLogger } from "fastify";

/**
 * Work a request starts but does not wait for (for example sending an email, so the response cannot reveal
 * whether there was anything to send). Failures are logged; `drain` waits for everything still running.
 */
export class BackgroundTasks {
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly log: FastifyBaseLogger) {}

  run(task: string, work: () => Promise<void>): void {
    const running: Promise<void> = work()
      .catch((error: unknown) => {
        this.log.error({ err: error, task }, "background task failed");
      })
      .finally(() => {
        this.pending.delete(running);
      });
    this.pending.add(running);
  }

  /** Tasks still running, for reporting what a forced shutdown abandons. */
  get pendingCount(): number {
    return this.pending.size;
  }

  async drain(): Promise<void> {
    await Promise.all([...this.pending]);
  }
}
