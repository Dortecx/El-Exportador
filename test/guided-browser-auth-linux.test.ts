import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("child_process", () => ({ spawn: spawnMock }));

function commandProbe(found: boolean): EventEmitter {
  const proc = new EventEmitter();
  queueMicrotask(() => {
    if (found) proc.emit("close", 0);
    else proc.emit("error", Object.assign(new Error("not found"), { code: "ENOENT" }));
  });
  return proc;
}

afterEach(() => {
  vi.resetModules();
  spawnMock.mockReset();
});

describe("guided browser auth Linux discovery", () => {
  it("discovers native Linux Chromium-compatible browsers without shell", async () => {
    spawnMock.mockImplementation((command: string) => commandProbe(command === "chromium"));
    const { preferredBrowser } = await import("../src/web/guidedBrowserAuth.js");

    await expect(preferredBrowser("linux")).resolves.toEqual({ id: "chrome", executable: "chromium" });
    expect(spawnMock).toHaveBeenCalledWith("google-chrome", ["--version"], { stdio: "ignore", windowsHide: true });
    expect(spawnMock).toHaveBeenCalledWith("google-chrome-stable", ["--version"], { stdio: "ignore", windowsHide: true });
    expect(spawnMock).toHaveBeenCalledWith("chromium", ["--version"], { stdio: "ignore", windowsHide: true });
  });

  it("returns undefined when no native Linux browser command is available", async () => {
    spawnMock.mockImplementation(() => commandProbe(false));
    const { preferredBrowser } = await import("../src/web/guidedBrowserAuth.js");

    await expect(preferredBrowser("linux")).resolves.toBeUndefined();
    expect(spawnMock).toHaveBeenCalledTimes(7);
  });
});
