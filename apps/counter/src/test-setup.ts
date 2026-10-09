import "@testing-library/jest-dom/vitest";
import "fake-indexeddb/auto";
import { cleanup } from "@testing-library/react";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, vi } from "vitest";
import { closeStorage } from "./storage.js";

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  // Each test starts with an empty IndexedDB.
  await closeStorage();
  globalThis.indexedDB = new IDBFactory();
});
