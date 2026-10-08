import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { runWorker, type WorkerTask } from "./worker.js";

const logger = pino({ level: "silent" });

function recordingTask(name: string, log: string[], failOn?: "start" | "stop"): WorkerTask {
  return {
    name,
    start() {
      if (failOn === "start") {
        return Promise.reject(new Error(`${name} start failed`));
      }
      log.push(`start ${name}`);
      return Promise.resolve();
    },
    stop() {
      if (failOn === "stop") {
        return Promise.reject(new Error(`${name} stop failed`));
      }
      log.push(`stop ${name}`);
      return Promise.resolve();
    },
  };
}

describe("runWorker", () => {
  it("starts tasks in order and stops them in reverse once aborted", async () => {
    const log: string[] = [];
    const controller = new AbortController();
    const running = runWorker([recordingTask("a", log), recordingTask("b", log)], logger, controller.signal);
    await new Promise((resolve) => setImmediate(resolve));
    expect(log).toEqual(["start a", "start b"]);
    controller.abort();
    await running;
    expect(log).toEqual(["start a", "start b", "stop b", "stop a"]);
  });

  it("stops already-started tasks and rejects when a task fails to start", async () => {
    const log: string[] = [];
    const tasks = [recordingTask("a", log), recordingTask("b", log, "start")];
    await expect(runWorker(tasks, logger, new AbortController().signal)).rejects.toThrow("b start failed");
    expect(log).toEqual(["start a", "stop a"]);
  });

  it("stops every task and rejects when one fails to stop", async () => {
    const log: string[] = [];
    const controller = new AbortController();
    controller.abort();
    const tasks = [recordingTask("a", log), recordingTask("b", log, "stop")];
    await expect(runWorker(tasks, logger, controller.signal)).rejects.toThrow(AggregateError);
    expect(log).toEqual(["start a", "start b", "stop a"]);
  });

  it("keeps the event loop alive while running and releases it once stopped", async () => {
    const timers = (): number => process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;
    const before = timers();
    const controller = new AbortController();
    const running = runWorker([], logger, controller.signal);
    await new Promise((resolve) => setImmediate(resolve));
    expect(timers()).toBe(before + 1);
    controller.abort();
    await running;
    expect(timers()).toBe(before);
  });
});
