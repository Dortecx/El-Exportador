import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: spawnMock }));
vi.mock("child_process", () => ({ spawn: spawnMock }));

function mockProcess(output: string) {
  spawnMock.mockImplementationOnce(() => {
    const proc = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    });
    queueMicrotask(() => {
      proc.stdout.emit("data", Buffer.from(output));
      proc.emit("close", 0);
    });
    return proc;
  });
}

afterEach(() => {
  vi.resetModules();
  spawnMock.mockReset();
});

describe("live YouTube Music auth validation", () => {
  it("does not validate at import time and returns the Python live validation result", async () => {
    const client = await import("../src/ytmusic/client.js");
    expect(spawnMock).not.toHaveBeenCalled();

    mockProcess('{"status":"invalid","reason":"authentication_required"}\n');
    await expect(client.validateYtMusicAuth()).resolves.toEqual({
      status: "invalid", reason: "authentication_required",
    });
  });

  it("turns a backend 401 into a controlled authentication-required error", async () => {
    mockProcess('{"error":"Authentication required","code":"AUTHENTICATION_REQUIRED"}\n');
    const { convertWithYtMusic, YTMusicAuthenticationRequiredError } = await import("../src/ytmusic/client.js");

    await expect(convertWithYtMusic(
      [{ artist: "Artist", title: "Song", file: "track.mp3" }], "playlist", { dryRun: true },
    )).rejects.toBeInstanceOf(YTMusicAuthenticationRequiredError);
  });

  it("uses the conversion reauthentication handling for manual search and Add Selected", async () => {
    const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
    const helper = html.match(/async function handleAuthenticationRequired\(response, payload\) \{[\s\S]*?(?=\n\s*function updateStartButton)/)?.[0];
    if (!helper) throw new Error("authentication handler was not found");

    const setAuthStatus = vi.fn();
    const clearCredentials = vi.fn();
    const showToast = vi.fn();
    const refreshProviderStates = vi.fn();
    const handleAuthenticationRequired = new Function(
      "setAuthStatus", "t", "window", "showToast", "refreshProviderStates", `${helper}; return handleAuthenticationRequired;`,
    )(setAuthStatus, (key: string) => key, { authStore: { getState: () => ({ clearCredentials }) } }, showToast, refreshProviderStates);

    expect(await handleAuthenticationRequired({ status: 401 }, { code: "AUTHENTICATION_REQUIRED" })).toBe(true);
    expect(setAuthStatus).toHaveBeenCalledWith("authUnauthenticated", "#FF4444", true);
    expect(clearCredentials).toHaveBeenCalledOnce();
    expect(showToast).toHaveBeenCalledWith("authConversionRequired", "error");
    expect(refreshProviderStates).toHaveBeenCalledOnce();

    expect(await handleAuthenticationRequired({ status: 500 }, { code: "AUTHENTICATION_REQUIRED" })).toBe(false);
    expect(await handleAuthenticationRequired({ status: 401 }, { code: "SPOTIFY_AUTHORIZATION_REQUIRED" })).toBe(false);
    expect(await handleAuthenticationRequired({ status: 401 }, { code: "SPOTIFY_AUTHENTICATION_REQUIRED" })).toBe(false);
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(refreshProviderStates).toHaveBeenCalledOnce();

    const manualSearch = html.match(/async function searchManualTrack[\s\S]*?(?=\n\s*function showManualReview)/)?.[0] || "";
    const addSelected = html.match(/addManualBtn\.addEventListener\('click',[\s\S]*?(?=\n\s*const startConversion)/)?.[0] || "";
    expect(manualSearch.indexOf("if (await handleAuthenticationRequired(response, payload)) return;")).toBeGreaterThan(-1);
    expect(manualSearch.indexOf("if (await handleAuthenticationRequired(response, payload)) return;")).toBeLessThan(manualSearch.indexOf("t('searchFailed')"));
    expect(addSelected.indexOf("if (await handleAuthenticationRequired(response, payload)) {")).toBeGreaterThan(-1);
    expect(addSelected.indexOf("if (await handleAuthenticationRequired(response, payload)) {")).toBeLessThan(addSelected.indexOf("t('couldNotAdd')"));
  });
});
