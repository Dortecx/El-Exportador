import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("child_process", () => ({ spawn: vi.fn() }));

afterEach(() => {
  vi.resetModules();
});

describe("YouTube Music Python resolver", () => {
  it("honors M3U_YTMUSIC_PYTHON before project venv and platform defaults", async () => {
    const { pythonCandidates } = await import("../src/ytmusic/client.js");
    const cwd = "/repo";
    const venv = path.join(cwd, ".venv", "bin", "python");

    expect(pythonCandidates({
      platform: "linux",
      configured: "/opt/python/bin/python",
      cwd,
      isUsableFile: (candidate) => candidate === venv,
    })).toEqual([
      "/opt/python/bin/python",
      venv,
      "python3",
      "python",
    ]);
  });

  it("uses a project-local Linux virtualenv before PATH defaults", async () => {
    const { pythonCandidates } = await import("../src/ytmusic/client.js");
    const cwd = "/repo";
    const venv = path.join(cwd, ".venv", "bin", "python");

    expect(pythonCandidates({
      platform: "linux",
      configured: undefined,
      cwd,
      isUsableFile: (candidate, platform) => candidate === venv && platform === "linux",
    })).toEqual([venv, "python3", "python"]);
  });

  it("uses a project-local Windows virtualenv before PATH defaults", async () => {
    const { pythonCandidates } = await import("../src/ytmusic/client.js");
    const cwd = "C:/repo";
    const venv = path.join(cwd, ".venv", "Scripts", "python.exe");

    expect(pythonCandidates({
      platform: "win32",
      configured: undefined,
      cwd,
      isUsableFile: (candidate, platform) => candidate === venv && platform === "win32",
    })).toEqual([venv, "python"]);
  });

  it("falls back exactly when the project virtualenv is absent", async () => {
    const { pythonCandidates } = await import("../src/ytmusic/client.js");

    expect(pythonCandidates({
      platform: "linux",
      configured: "",
      cwd: "/repo",
      isUsableFile: () => false,
    })).toEqual(["python3", "python"]);

    expect(pythonCandidates({
      platform: "win32",
      configured: undefined,
      cwd: "C:/repo",
      isUsableFile: () => false,
    })).toEqual(["python"]);
  });

  it("does not report duplicate candidates", async () => {
    const { pythonCandidates } = await import("../src/ytmusic/client.js");
    const cwd = "/repo";
    const venv = path.join(cwd, ".venv", "bin", "python");

    expect(pythonCandidates({
      platform: "linux",
      configured: venv,
      cwd,
      isUsableFile: (candidate) => candidate === venv,
    })).toEqual([venv, "python3", "python"]);
  });
});
