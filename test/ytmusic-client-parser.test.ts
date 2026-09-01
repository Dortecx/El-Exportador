import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { describe, it, expect, vi, afterEach } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ spawn: spawnMock }));
vi.mock("child_process", () => ({ spawn: spawnMock }));

function mockProcess(chunks: string[]) {
  spawnMock.mockImplementationOnce(() => {
    const proc = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });

    queueMicrotask(() => {
      for (const chunk of chunks) {
        proc.stdout.emit("data", Buffer.from(chunk));
      }
      proc.emit("close", 0);
    });

    return proc;
  });
}

afterEach(() => {
  vi.resetModules();
  spawnMock.mockReset();
});

describe("YTMusic stdout JSON parser", () => {
  it("buffers split frames, processes multiple frames per chunk, and flushes a trailing frame on close", async () => {
    mockProcess([
      '{"progress":{"current":1,"total":2,"artist":"First","title":"Song","status":"matched"}}\n{"progress":{"current":2,"total":2,"artist":"Second","title":"Song","status":"matched"}}\n{"status":"mat',
      'ched","artist":"Final","title":"Result","videoId":"video-1"}',
    ]);

    const { convertWithYtMusic } = await import("../src/ytmusic/client.js");
    const onProgress = vi.fn();

    await expect(convertWithYtMusic(
      [{ artist: "artist", title: "title", file: "track.mp3" }],
      "playlist",
      { dryRun: true },
      onProgress,
    )).resolves.toEqual({
      status: "matched",
      artist: "Final",
      title: "Result",
      videoId: "video-1",
    });
    expect(onProgress).toHaveBeenNthCalledWith(1, 1, 2, "First", "Song", "matched");
    expect(onProgress).toHaveBeenNthCalledWith(2, 2, 2, "Second", "Song", "matched");
  });

  it("resolves an add-to-playlist success result", async () => {
    mockProcess(['{"success":true,"added":1}\n']);

    const { addToPlaylistOnYtMusic } = await import("../src/ytmusic/client.js");

    await expect(addToPlaylistOnYtMusic("playlist-id", ["video-id"])).resolves.toEqual({
      success: true,
      added: 1,
    });
  });
});
