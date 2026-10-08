import type { Logger } from "pino";

/** A unit of background work the worker starts and stops with its own lifecycle. */
export interface WorkerTask {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Starts every task, then resolves once `signal` aborts and every started task has stopped.
 * A task that fails to start stops the ones already started and rejects, so the process exits non-zero.
 */
export async function runWorker(tasks: readonly WorkerTask[], logger: Logger, signal: AbortSignal): Promise<void> {
  const started: WorkerTask[] = [];
  try {
    for (const task of tasks) {
      await task.start();
      started.push(task);
      logger.info({ task: task.name }, "task started");
    }
  } catch (error) {
    logger.error({ err: error, task: tasks[started.length]?.name }, "task failed to start");
    await stopAll(started, logger);
    throw error;
  }
  logger.info({ taskCount: started.length }, "worker running");

  await waitForAbort(signal);

  logger.info("worker stopping");
  await stopAll(started, logger);
  logger.info("worker stopped");
}

/** How often the keep-alive timer fires while waiting; it does nothing but hold the event loop open. */
const KEEP_ALIVE_INTERVAL_MS = 60_000;

/**
 * Resolves when `signal` aborts. A pending promise does not keep Node running, so a timer is held until then;
 * without it the worker would exit as soon as it has no task with open sockets or timers of its own.
 */
function waitForAbort(signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const keepAlive = setInterval(() => undefined, KEEP_ALIVE_INTERVAL_MS);
    signal.addEventListener(
      "abort",
      () => {
        clearInterval(keepAlive);
        resolve();
      },
      { once: true },
    );
  });
}

async function stopAll(tasks: readonly WorkerTask[], logger: Logger): Promise<void> {
  const failures: unknown[] = [];
  for (const task of [...tasks].reverse()) {
    try {
      await task.stop();
      logger.info({ task: task.name }, "task stopped");
    } catch (error) {
      logger.error({ err: error, task: task.name }, "task failed to stop");
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `${String(failures.length)} task(s) failed to stop`);
  }
}
