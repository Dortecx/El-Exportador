import { spawn, type ChildProcess } from "child_process";
import { randomInt } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import CDP from "chrome-remote-interface";
import { YTMusicAuthFile } from "../ytmusic/client";

const MUSIC_URL = "https://music.youtube.com";
const STATE_ROOT = process.env.M3U_YTMUSIC_STATE_DIR?.trim() || os.homedir();
const PROFILE_ROOT = path.join(STATE_ROOT, ".config", "m3u-to-ytmusic", "browser-profile");
const TIMEOUT_MS = 5 * 60 * 1000;
const CORRELATION_TTL_MS = 30_000;
const MAX_PENDING_CORRELATIONS = 100;
const ALLOWED_HEADERS = new Set([
  "cookie", "authorization", "x-goog-authuser", "x-goog-visitor-id", "x-origin", "origin",
  "referer", "user-agent", "content-type", "x-youtube-client-name", "x-youtube-client-version",
]);

type BrowserId = "edge" | "helium" | "chrome" | "brave" | "opera";
type AuthStatus = "idle" | "launching" | "waiting_for_sign_in" | "validating" | "connected" | "cancelled" | "timed_out" | "error";
type Browser = { id: BrowserId; executable: string };
type Validator = (headers: string) => Promise<{ status: string; error?: string }>;
type RequestWillBeSentEvent = { requestId: string; request: { url: string } };
type RequestWillBeSentExtraInfoEvent = { requestId: string; headers: Record<string, string> };
type PendingHeaders = { headers: string; observedAt: number };
type CdpSession = Awaited<ReturnType<typeof CDP>>;
type CdpAttachment = { cdp: CdpSession; targetId: string };

const browserPaths: Record<BrowserId, string[]> = {
  edge: ["Microsoft/Edge/Application/msedge.exe", "Microsoft/Edge Beta/Application/msedge.exe"],
  helium: ["imput/Helium/Application/chrome.exe"],
  chrome: ["Google/Chrome/Application/chrome.exe", "Google/Chrome Beta/Application/chrome.exe"],
  brave: ["BraveSoftware/Brave-Browser/Application/brave.exe"],
  opera: ["Programs/Opera/launcher.exe", "Opera/launcher.exe", "Programs/Opera GX/opera.exe"],
};

function executableFor(id: BrowserId): string | undefined {
  const roots = [process.env.LOCALAPPDATA, process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"]].filter(Boolean) as string[];
  return roots.flatMap((root) => browserPaths[id].map((relative) => path.join(root, relative))).find(fs.existsSync);
}

function idForExecutable(executable: string): BrowserId | undefined {
  const normalizedPath = executable.replace(/\//g, "\\").toLowerCase();
  const name = path.basename(executable).toLowerCase();
  if (name === "msedge.exe") return "edge";
  if (normalizedPath.endsWith("\\imput\\helium\\application\\chrome.exe")) return "helium";
  if (name === "chrome.exe") return "chrome";
  if (name === "brave.exe") return "brave";
  if ((name === "launcher.exe" || name === "opera.exe") && executable.toLowerCase().includes("opera")) return "opera";
  return undefined;
}

function readRegistry(key: string, value: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn("reg", ["query", key, "/v", value], { windowsHide: true });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.on("error", () => resolve(undefined));
    child.on("close", (code) => {
      if (code !== 0) return resolve(undefined);
      const match = output.match(/REG_\w+\s+(.+)\s*$/m);
      resolve(match?.[1]?.trim());
    });
  });
}

function commandExecutable(command: string | undefined): string | undefined {
  if (!command) return undefined;
  const quoted = command.match(/^\s*"([^"]+\.exe)"/i)?.[1];
  const unquoted = command.match(/^\s*([^\s]+\.exe)/i)?.[1];
  const executable = quoted || unquoted;
  return executable && fs.existsSync(executable) ? executable : undefined;
}

async function preferredBrowser(): Promise<Browser | undefined> {
  const preferred = ["helium", "chrome", "brave", "opera"] as BrowserId[];
  const progId = await readRegistry("HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice", "ProgId");
  const executable = commandExecutable(await readRegistry(`HKCR\\${progId}\\shell\\open\\command`, "(Default)"));
  const id = executable && idForExecutable(executable);
  if (id && executable && preferred.includes(id)) return { id, executable };
  for (const fallback of [...preferred, "edge"] as BrowserId[]) {
    const installed = executableFor(fallback);
    if (installed) return { id: fallback, executable: installed };
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class GuidedBrowserAuth {
  private statusValue: AuthStatus = "idle";
  private browser?: ChildProcess;
  private cdp?: CdpSession;
  private cdpPort?: number;
  private activeLoginTargetId?: string;
  private timeout?: NodeJS.Timeout;
  private correlationEviction?: NodeJS.Timeout;
  private profile?: string;
  private stopped = false;
  private operation = 0;
  private disconnectCleanup?: Promise<void>;
  private readonly musicRequestCandidates = new Map<string, number>();
  private readonly pendingRequestHeaders = new Map<string, PendingHeaders>();

  constructor(private readonly validate: Validator) {}

  status(): { status: AuthStatus } {
    return { status: this.statusValue };
  }

  async start(): Promise<{ status: AuthStatus; error?: string }> {
    if (process.platform !== "win32") return { status: "error", error: "Guided browser authentication is available on Windows only" };
    await this.waitForDisconnectCleanup();
    if (["launching", "waiting_for_sign_in", "validating"].includes(this.statusValue)) return this.status();
    if (this.statusValue === "connected") return this.status();

    const browser = await preferredBrowser();
    await this.waitForDisconnectCleanup();
    if (["launching", "waiting_for_sign_in", "validating", "connected"].includes(this.statusValue)) return this.status();
    if (!browser) {
      this.statusValue = "error";
      return { status: this.statusValue, error: "No supported Chromium-compatible browser was found" };
    }

    console.info("[guided-auth] browser selected");
    this.stopped = false;
    const operation = ++this.operation;
    this.profile = path.join(PROFILE_ROOT, browser.id);
    await fs.promises.mkdir(this.profile, { recursive: true });
    const port = randomInt(20000, 60000);
    this.cdpPort = port;
    this.statusValue = "launching";
    console.info("[guided-auth] browser launch requested");
    const targetArgs = browser.id === "opera"
      ? ["--new-window", "--window-size=520,760", MUSIC_URL]
      : [`--app=${MUSIC_URL}`, "--window-size=520,760"];
    const launchedBrowser = this.browser = spawn(browser.executable, [
      ...targetArgs,
      `--user-data-dir=${this.profile}`,
      "--remote-debugging-address=127.0.0.1",
      `--remote-debugging-port=${port}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-gpu",
      "--disable-gpu-shader-disk-cache",
    ], { detached: false, windowsHide: false });
    console.info("[guided-auth] browser process spawned");
    launchedBrowser.once("error", () => {
      console.warn("[guided-auth] browser process startup failed");
      if (!this.stopped && this.operation === operation) this.statusValue = "error";
    });
    launchedBrowser.once("exit", (code, signal) => {
      console.info("[guided-auth] browser process exited", { code, signal });
      if (this.browser === launchedBrowser && this.operation === operation && !this.stopped
        && ["launching", "waiting_for_sign_in", "validating"].includes(this.statusValue)) {
        void this.stop("cancelled");
      }
    });
    this.timeout = setTimeout(() => {
      if (this.operation !== operation) return;
      console.warn("[guided-auth] authentication timed out");
      void this.stop("timed_out");
    }, TIMEOUT_MS);
    console.info("[guided-auth] CDP waiting");
    void this.observe(port, operation);
    return this.status();
  }

  async cancel(): Promise<{ status: AuthStatus }> {
    console.info("[guided-auth] cancellation requested");
    await this.stop("cancelled");
    return this.status();
  }

  async disconnect(): Promise<{ status: AuthStatus }> {
    console.info("[guided-auth] disconnect requested");
    const operation = this.operation;
    const profile = this.profile;
    let cleanup: Promise<void>;
    cleanup = (async () => {
      const stoppedOperation = await this.stop("idle");
      if (stoppedOperation !== operation + 1 || this.operation !== stoppedOperation) return;
      await Promise.all([
        profile ? fs.promises.rm(profile, { recursive: true, force: true }) : Promise.resolve(),
        fs.promises.rm(YTMusicAuthFile, { force: true }),
      ]);
    })().finally(() => {
      if (this.disconnectCleanup === cleanup) this.disconnectCleanup = undefined;
    });
    this.disconnectCleanup = cleanup;
    await cleanup;
    return this.status();
  }

  private async waitForDisconnectCleanup(): Promise<void> {
    const cleanup = this.disconnectCleanup;
    if (cleanup) await cleanup;
  }

  private async observe(port: number, operation: number): Promise<void> {
    try {
      const { cdp, targetId } = await this.waitForCdp(port);
      console.info("[guided-auth] CDP attached");
      if (this.stopped || this.operation !== operation) {
        await cdp.close().catch(() => undefined);
        return;
      }
      this.cdp = cdp;
      this.activeLoginTargetId = targetId;
      await this.cdp.Network.enable();
      if (this.stopped || this.operation !== operation) {
        await cdp.close().catch(() => undefined);
        return;
      }
      this.statusValue = "waiting_for_sign_in";
      this.startCorrelationEviction();
      this.cdp.Network.requestWillBeSent((event: RequestWillBeSentEvent) => {
        if (this.operation === operation) this.observeMusicApiRequest(event, operation);
      });
      this.cdp.Network.requestWillBeSentExtraInfo((event: RequestWillBeSentExtraInfoEvent) => {
        if (this.operation === operation) this.observeRequestHeaders(event, operation);
      });
    } catch {
      console.warn("[guided-auth] CDP startup failure");
      if (!this.stopped && this.operation === operation && this.statusValue !== "connected") this.statusValue = "error";
    }
  }

  private observeMusicApiRequest(event: RequestWillBeSentEvent, operation: number): void {
    if (this.statusValue !== "waiting_for_sign_in" || !event.request.url.startsWith(`${MUSIC_URL}/youtubei/v1/`)) return;
    this.evictExpiredCorrelations();
    this.storePending(this.musicRequestCandidates, event.requestId, Date.now());
    this.tryCompleteCorrelatedRequest(event.requestId, operation);
  }

  private observeRequestHeaders(event: RequestWillBeSentExtraInfoEvent, operation: number): void {
    if (this.statusValue !== "waiting_for_sign_in") return;
    this.evictExpiredCorrelations();
    const headers = Object.entries(event.headers)
      .filter(([name]) => ALLOWED_HEADERS.has(name.toLowerCase()))
      .map(([name, value]) => `${name}: ${value}`)
      .join("\n");
    if (!headers) return;
    this.storePending(this.pendingRequestHeaders, event.requestId, { headers, observedAt: Date.now() });
    this.tryCompleteCorrelatedRequest(event.requestId, operation);
  }

  private tryCompleteCorrelatedRequest(requestId: string, operation: number): void {
    const pendingHeaders = this.pendingRequestHeaders.get(requestId);
    if (!this.musicRequestCandidates.has(requestId) || !pendingHeaders || !this.hasNonEmptyCookie(pendingHeaders.headers)) return;
    this.musicRequestCandidates.delete(requestId);
    this.pendingRequestHeaders.delete(requestId);
    console.info("[guided-auth] usable auth metadata captured");
    void this.complete(pendingHeaders.headers, operation);
  }

  private hasNonEmptyCookie(headers: string): boolean {
    return headers.split("\n").some((header) => {
      const separator = header.indexOf(":");
      return separator > 0 && header.slice(0, separator).toLowerCase() === "cookie" && header.slice(separator + 1).trim().length > 0;
    });
  }

  private storePending<T>(entries: Map<string, T>, requestId: string, value: T): void {
    if (!entries.has(requestId) && entries.size >= MAX_PENDING_CORRELATIONS) entries.delete(entries.keys().next().value!);
    entries.set(requestId, value);
  }

  private startCorrelationEviction(): void {
    if (this.correlationEviction) return;
    this.correlationEviction = setInterval(() => this.evictExpiredCorrelations(), 1_000);
  }

  private evictExpiredCorrelations(): void {
    const expiresAt = Date.now() - CORRELATION_TTL_MS;
    for (const [requestId, observedAt] of this.musicRequestCandidates) {
      if (observedAt <= expiresAt) this.musicRequestCandidates.delete(requestId);
    }
    for (const [requestId, pendingHeaders] of this.pendingRequestHeaders) {
      if (pendingHeaders.observedAt <= expiresAt) this.pendingRequestHeaders.delete(requestId);
    }
  }

  private clearRequestCorrelations(): void {
    if (this.correlationEviction) clearInterval(this.correlationEviction);
    this.correlationEviction = undefined;
    this.musicRequestCandidates.clear();
    this.pendingRequestHeaders.clear();
  }

  private async waitForCdp(port: number): Promise<CdpAttachment> {
    for (let elapsed = 0; elapsed < 30_000 && !this.stopped; elapsed += 250) {
      try {
        const targets = await CDP.List({ host: "127.0.0.1", port });
        const target = targets.find(({ type, url }) => type === "page" && url.startsWith(MUSIC_URL));
        if (target) {
          console.info("[guided-auth] Music page target found");
          return { cdp: await CDP({ host: "127.0.0.1", port, target }), targetId: target.id };
        }
      } catch { /* browser debugging port is not available yet */ }
      await sleep(250);
    }
    throw new Error("Browser debugging port did not become available");
  }

  private async complete(headers: string, operation: number): Promise<void> {
    if (this.stopped || this.operation !== operation || this.statusValue !== "waiting_for_sign_in") return;
    this.statusValue = "validating";
    console.info("[guided-auth] validation beginning");
    try {
      const result = await this.validate(headers);
      if (result.status === "authorized" && !this.stopped && this.operation === operation && this.statusValue === "validating") {
        console.info(`[guided-auth] validation accepted status=${result.status}`);
        this.statusValue = "connected";
        await this.closeResources();
      } else if (!this.stopped && this.operation === operation && this.statusValue === "validating") {
        console.warn(`[guided-auth] validation rejected status=${result.status}`);
        this.statusValue = "waiting_for_sign_in";
      }
    } catch {
      console.warn("[guided-auth] validation errored status=error");
      if (!this.stopped && this.operation === operation && this.statusValue === "validating") this.statusValue = "waiting_for_sign_in";
    }
  }

  private async stop(status: AuthStatus): Promise<number> {
    const operation = ++this.operation;
    this.stopped = true;
    this.statusValue = status;
    await this.closeResources();
    return operation;
  }

  private async closeExtraPageTargets(port: number, activeTargetId: string | undefined): Promise<void> {
    if (!activeTargetId) return;
    try {
      const targets = await CDP.List({ host: "127.0.0.1", port });
      const extraPageTargetIds = new Set(
        targets
          .filter((target) => target.type === "page" && target.id !== activeTargetId)
          .map((target) => target.id),
      );
      if (extraPageTargetIds.size === 0) return;
      await Promise.allSettled(
        [...extraPageTargetIds].map((id) => CDP.Close({ host: "127.0.0.1", port, id })),
      );

      for (let attempt = 0; attempt < 5; attempt += 1) {
        const remainingTargetIds = new Set((await CDP.List({ host: "127.0.0.1", port })).map((target: { id: string }) => target.id));
        if (![...extraPageTargetIds].some((id) => remainingTargetIds.has(id))) return;
        if (attempt < 4) await sleep(100);
      }
    } catch {
      // CDP may already be disconnected or the browser may already be closed.
    }
  }

  private async waitForBrowserExit(browser: ChildProcess): Promise<void> {
    if (browser.exitCode !== null || browser.killed) return;
    await Promise.race([
      new Promise<void>((resolve) => browser.once("exit", () => resolve())),
      sleep(1_000),
    ]);
  }

  private async closeResources(): Promise<void> {
    console.info("[guided-auth] cleanup");
    this.clearRequestCorrelations();
    if (this.timeout) clearTimeout(this.timeout);
    this.timeout = undefined;

    const cdp = this.cdp;
    const port = this.cdpPort;
    const activeTargetId = this.activeLoginTargetId;
    const browser = this.browser;
    this.cdp = undefined;
    this.cdpPort = undefined;
    this.activeLoginTargetId = undefined;
    this.browser = undefined;

    if (port !== undefined) await this.closeExtraPageTargets(port, activeTargetId);
    let gracefulCdp = cdp;
    if (!gracefulCdp && port !== undefined && activeTargetId) {
      gracefulCdp = await CDP({ host: "127.0.0.1", port, target: activeTargetId }).catch(() => undefined);
    }
    if (gracefulCdp) {
      await gracefulCdp.Browser.close().catch(() => undefined);
      await gracefulCdp.close().catch(() => undefined);
    }
    if (browser && !browser.killed) {
      await this.waitForBrowserExit(browser);
      if (browser.exitCode === null && !browser.killed) browser.kill();
    }
  }
}
