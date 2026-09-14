import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("child_process", () => ({ spawn: spawnMock }));

type FakeProcess = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
};

const childProcesses = new Set<FakeProcess>();

function fakeProcess(): FakeProcess {
  const proc = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
  }) as FakeProcess;
  childProcesses.add(proc);
  return proc;
}

afterEach(() => {
  for (const proc of childProcesses) {
    proc.emit("close", null);
    proc.stdin.end();
    proc.stdout.end();
    proc.stderr.end();
    proc.stdin.removeAllListeners();
    proc.stdout.removeAllListeners();
    proc.stderr.removeAllListeners();
    proc.removeAllListeners();
  }
  childProcesses.clear();
  vi.resetModules();
  spawnMock.mockReset();
});

describe("YouTube Music conversion cancellation", () => {
  it("does not spawn a playlist-creating subprocess when the run is already cancelled", async () => {
    const { convertWithYtMusic } = await import("../src/ytmusic/client.js");

    await expect(convertWithYtMusic(
      [{ artist: "Artist", title: "Song", file: "track.mp3" }], "playlist", { dryRun: false }, undefined, () => true,
    )).rejects.toMatchObject({ message: "YouTube Music operation cancelled", name: "AbortError" });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("terminates a running playlist conversion on cancellation and preserves its AbortError", async () => {
    const proc = fakeProcess();
    const kill = vi.fn(() => proc.emit("close", null));
    proc.kill = kill;
    spawnMock.mockReturnValueOnce(proc);
    let cancelled = false;
    const { convertWithYtMusic } = await import("../src/ytmusic/client.js");
    const conversion = convertWithYtMusic(
      [{ artist: "Artist", title: "Song", file: "track.mp3" }], "playlist", { dryRun: false }, undefined, () => cancelled,
    );

    cancelled = true;
    await expect(conversion).rejects.toMatchObject({ message: "YouTube Music operation cancelled", name: "AbortError" });
    expect(kill).toHaveBeenCalledOnce();
    expect(kill).toHaveBeenCalledWith("SIGTERM");
    expect(proc.stdin.read().toString()).toContain('"createPlaylist":true');
  });

  it("still reports non-cancellation subprocess failures as backend execution errors", async () => {
    const expectedCandidates = process.platform === "win32" ? ["python"] : ["python3", "python"];
    const procs = expectedCandidates.map(fakeProcess);
    for (const proc of procs) spawnMock.mockReturnValueOnce(proc);
    const { convertWithYtMusic } = await import("../src/ytmusic/client.js");
    const conversion = convertWithYtMusic(
      [{ artist: "Artist", title: "Song", file: "track.mp3" }], "playlist", { dryRun: false },
    );

    for (let index = 0; index < expectedCandidates.length; index += 1) {
      while (spawnMock.mock.calls.length <= index) await Promise.resolve();
      procs[index].emit("error", new Error(`fake ${expectedCandidates[index]} failure`));
      await Promise.resolve();
    }
    const attempts = expectedCandidates.map((candidate) => `${candidate}: fake ${candidate} failure`).join(" | ");
    await expect(conversion).rejects.toThrow(`Could not execute ytmusic backend. Attempts: ${attempts}`);
  });
});
