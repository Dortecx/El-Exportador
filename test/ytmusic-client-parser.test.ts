import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
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
      'ched","artist":"Final","title":"Result","videoId":"video-1","bestMatch":null}',
    ]);

    const { convertWithYtMusic } = await import("../src/ytmusic/client.js");
    const onProgress = vi.fn();

    await expect(convertWithYtMusic(
      [{ artist: "artist", title: "title", file: "track.mp3" }],
      "playlist",
      { dryRun: true },
      onProgress,
    )).resolves.toEqual({
      playlistId: null,
      playlistUrl: null,
      matched: 1,
      results: [{
        status: "matched",
        artist: "Final",
        title: "Result",
        videoId: "video-1",
        bestMatch: null,
      }],
    });
    expect(onProgress).toHaveBeenNthCalledWith(1, 1, 2, "First", "Song", "matched");
    expect(onProgress).toHaveBeenNthCalledWith(2, 2, 2, "Second", "Song", "matched");
  });

  it("accepts a search_error result as a distinct technical retry state", async () => {
    mockProcess(['{"status":"search_error","reason":"search_error","artist":"Artist","title":"Song","videoId":null,"bestMatch":null}\n']);

    const { convertWithYtMusic } = await import("../src/ytmusic/client.js");

    await expect(convertWithYtMusic(
      [{ artist: "Artist", title: "Song", file: "track.mp3" }],
      "playlist",
      { dryRun: true },
    )).resolves.toMatchObject({
      matched: 0,
      results: [{ status: "search_error", reason: "search_error", videoId: null }],
    });
  });

  it("accepts a playlist creation failure and sanitizes raw provider details", async () => {
    mockProcess(['{"playlistId":null,"playlistUrl":null,"matched":1,"results":[{"status":"matched","artist":"Artist","title":"Song","videoId":"video-1","bestMatch":{"title":"Song","artist":"Artist","videoId":"video-1"}}],"manualReviewTracks":[],"playlistCreationFailure":{"code":"YTMUSIC_PLAYLIST_CREATE_FAILED","message":"raw provider secret must not leak"}}\n']);

    const { convertWithYtMusic } = await import("../src/ytmusic/client.js");

    await expect(convertWithYtMusic(
      [{ artist: "Artist", title: "Song", file: "track.mp3" }],
      "playlist",
      { dryRun: false },
    )).resolves.toMatchObject({
      matched: 1,
      playlistCreationFailure: {
        code: "YTMUSIC_PLAYLIST_CREATE_FAILED",
        message: "YouTube Music could not create the playlist. Matched tracks are available below.",
      },
      playlistId: null,
      playlistUrl: null,
    });
  });

  it("accepts an unconfirmed playlist creation outcome and sanitizes raw provider details", async () => {
    mockProcess(['{"playlistId":null,"playlistUrl":null,"matched":1,"results":[{"status":"matched","artist":"Artist","title":"Song","videoId":"video-1","bestMatch":{"title":"Song","artist":"Artist","videoId":"video-1"}}],"manualReviewTracks":[],"playlistCreationFailure":{"code":"YTMUSIC_PLAYLIST_CREATION_UNCONFIRMED","message":"raw provider secret must not leak"}}\n']);

    const { convertWithYtMusic } = await import("../src/ytmusic/client.js");

    await expect(convertWithYtMusic(
      [{ artist: "Artist", title: "Song", file: "track.mp3" }],
      "playlist",
      { dryRun: false },
    )).resolves.toMatchObject({
      matched: 1,
      playlistCreationFailure: {
        code: "YTMUSIC_PLAYLIST_CREATION_UNCONFIRMED",
        message: "YouTube Music playlist creation is unconfirmed. Matched tracks are available below; no playlist URL can be shown safely.",
      },
      playlistId: null,
      playlistUrl: null,
    });
  });

  it("rejects malformed standalone results", async () => {
    mockProcess(['{"status":"matched","artist":"Final","title":"Result","videoId":"video-1"}\n']);

    const { convertWithYtMusic } = await import("../src/ytmusic/client.js");

    await expect(convertWithYtMusic(
      [{ artist: "artist", title: "title", file: "track.mp3" }],
      "playlist",
      { dryRun: true },
    )).rejects.toThrow("YouTube Music returned an invalid conversion result");
  });

  it("requires pykakasi for the portable frozen backend", async () => {
    const [requirements, builder] = await Promise.all([
      readFile("requirements.txt", "utf8"),
      readFile("scripts/build-portable-win.ps1", "utf8"),
    ]);

    expect(requirements).toContain("pykakasi==2.3.0");
    expect(builder).toContain("-m pip install -r");
    expect(builder).toContain("--collect-data pykakasi");
  });

  it("launches the backend without emitting the routine process-launch log", async () => {
    mockProcess(['{"success":true,"added":1}\n']);
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      const { addToPlaylistOnYtMusic } = await import("../src/ytmusic/client.js");

      await expect(addToPlaylistOnYtMusic("playlist-id", ["video-id"])).resolves.toEqual({
        success: true,
        added: 1,
      });
      expect(consoleLogSpy).not.toHaveBeenCalledWith(expect.stringContaining("🐍 Ejecutando:"));
    } finally {
      consoleLogSpy.mockRestore();
    }
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
