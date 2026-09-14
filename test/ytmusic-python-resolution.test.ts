import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("child_process", () => ({ spawn: vi.fn() }));

afterEach(() => {
  vi.resetModules();
});

describe("YouTube Music Python resolver", () => {
  it("honors M3U_YTMUSIC_PYTHON before platform defaults", async () => {
    const { pythonCandidates } = await import("../src/ytmusic/client.js");

    expect(pythonCandidates("linux", "/opt/python/bin/python")).toEqual([
      "/opt/python/bin/python",
      "python3",
      "python",
    ]);
  });

  it("prefers python on Windows", async () => {
    const { pythonCandidates } = await import("../src/ytmusic/client.js");

    expect(pythonCandidates("win32", undefined)).toEqual(["python"]);
  });

  it("prefers python3 then python on non-Windows platforms", async () => {
    const { pythonCandidates } = await import("../src/ytmusic/client.js");

    expect(pythonCandidates("linux", "")).toEqual(["python3", "python"]);
  });
});
