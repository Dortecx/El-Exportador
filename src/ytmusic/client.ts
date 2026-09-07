import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import fs from 'fs';
import type { Track } from '../types.js';

// Obtener la ruta del directorio actual usando import.meta.url
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// A packaged Windows build supplies the frozen searcher through this environment variable.
// Source checkouts keep using the Python script beside this module.
const PACKAGED_SEARCHER = process.env.M3U_YTMUSIC_SEARCHER?.trim();
const SEARCHER_SCRIPT = path.join(__dirname, 'searcher.py');

if (!PACKAGED_SEARCHER && !fs.existsSync(SEARCHER_SCRIPT)) {
  console.error(`❌ Error: El script ${SEARCHER_SCRIPT} no existe`);
  process.exit(1);
}

// Use the Python interpreter available in the PowerShell PATH.
const PYTHON_CANDIDATES = ["python"];

const STATE_ROOT = process.env.M3U_YTMUSIC_STATE_DIR?.trim() || os.homedir();
export const YTMusicAuthFile = path.join(STATE_ROOT, '.config', 'm3u-to-ytmusic', 'ytmusic_auth.json');

export type YTMusicAuthValidationStatus = 'valid' | 'missing' | 'invalid' | 'unexpected_failure';

export interface YTMusicAuthValidationResult {
  status: YTMusicAuthValidationStatus;
  reason?: string;
}

export class YTMusicAuthenticationRequiredError extends Error {
  readonly code = 'AUTHENTICATION_REQUIRED';

  constructor() {
    super('Authentication required');
    this.name = 'YTMusicAuthenticationRequiredError';
  }
}

/** Validates the configured auth file with a minimal live authenticated request. */
export async function validateYtMusicAuth(): Promise<YTMusicAuthValidationResult> {
  const result = await runYtMusicScript({ action: "validate-auth" });
  if (isScriptResponse(result) && (result.status === "valid" || result.status === "missing" || result.status === "invalid" || result.status === "unexpected_failure")) {
    return { status: result.status, ...(typeof result.reason === "string" ? { reason: result.reason } : {}) };
  }
  return { status: 'unexpected_failure', reason: 'validation_failed' };
}

/** Verifica si el usuario está autenticado con YouTube Music. */
export async function checkYtMusicAvailable(): Promise<boolean> {
  return (await validateYtMusicAuth()).status === 'valid';
}

export interface YTMusicBestMatch {
  title: string;
  artist: string;
  videoId: string;
}

export interface YTMusicSearchResult {
  status: 'matched' | 'unmatched' | 'ambiguous';
  artist: string;
  title: string;
  videoId: string | null;
  bestMatch: YTMusicBestMatch | null;
}

export interface YTMusicConversionResult {
  playlistId: string | null;
  playlistUrl: string | null;
  matched: number;
  results: YTMusicSearchResult[];
  unmatchedTracks?: YTMusicSearchResult[];
  ambiguousTracks?: YTMusicSearchResult[];
  manualReviewTracks?: YTMusicSearchResult[];
}

export type ProgressCallback = (current: number, total: number, artist: string, title: string, status: string) => void;

export type YTMusicManualSearchResult = {
  error?: string;
  hasMore?: boolean;
  pageCount?: number;
  resultCount?: number;
  results?: unknown[];
};

export type YTMusicAddToPlaylistResult = { added?: number; success?: boolean };

type YTMusicScriptResponse = Record<string, unknown>;
type YTMusicProgress = { current: number; total: number; artist: string; title: string; status: string };

function isScriptResponse(value: unknown): value is YTMusicScriptResponse {
  return typeof value === "object" && value !== null;
}

function isProgress(value: unknown): value is YTMusicProgress {
  if (!isScriptResponse(value)) return false;
  return Number.isFinite(value.current)
    && Number.isFinite(value.total)
    && typeof value.artist === "string"
    && typeof value.title === "string"
    && typeof value.status === "string";
}

function toManualSearchResult(value: unknown): YTMusicManualSearchResult {
  if (!isScriptResponse(value)) return {};
  return {
    ...(typeof value.error === "string" ? { error: value.error } : {}),
    ...(typeof value.hasMore === "boolean" ? { hasMore: value.hasMore } : {}),
    ...(typeof value.pageCount === "number" && Number.isInteger(value.pageCount) ? { pageCount: value.pageCount } : {}),
    ...(typeof value.resultCount === "number" && Number.isInteger(value.resultCount) ? { resultCount: value.resultCount } : {}),
    ...(Array.isArray(value.results) ? { results: value.results } : {}),
  };
}

function toAddToPlaylistResult(value: unknown): YTMusicAddToPlaylistResult {
  if (!isScriptResponse(value)) return {};
  return {
    ...(typeof value.success === "boolean" ? { success: value.success } : {}),
    ...(typeof value.added === "number" && Number.isInteger(value.added) ? { added: value.added } : {}),
  };
}

function isYTMusicBestMatch(value: unknown): value is YTMusicBestMatch {
  return isScriptResponse(value)
    && typeof value.title === "string"
    && typeof value.artist === "string"
    && typeof value.videoId === "string";
}

function isYTMusicSearchResult(value: unknown): value is YTMusicSearchResult {
  return isScriptResponse(value)
    && (value.status === "matched" || value.status === "unmatched" || value.status === "ambiguous")
    && typeof value.artist === "string"
    && typeof value.title === "string"
    && (typeof value.videoId === "string" || value.videoId === null)
    && (isYTMusicBestMatch(value.bestMatch) || value.bestMatch === null);
}

function toYTMusicConversionResult(value: unknown): YTMusicConversionResult | null {
  if (isYTMusicSearchResult(value)) {
    return {
      playlistId: null,
      playlistUrl: null,
      matched: value.status === "matched" ? 1 : 0,
      results: [value],
    };
  }
  if (!isScriptResponse(value)
    || (typeof value.playlistId !== "string" && value.playlistId !== null)
    || (typeof value.playlistUrl !== "string" && value.playlistUrl !== null)
    || typeof value.matched !== "number" || !Number.isInteger(value.matched)
    || !Array.isArray(value.results) || !value.results.every(isYTMusicSearchResult)) return null;
  if ((value.unmatchedTracks !== undefined && (!Array.isArray(value.unmatchedTracks) || !value.unmatchedTracks.every(isYTMusicSearchResult)))
    || (value.ambiguousTracks !== undefined && (!Array.isArray(value.ambiguousTracks) || !value.ambiguousTracks.every(isYTMusicSearchResult)))
    || (value.manualReviewTracks !== undefined && (!Array.isArray(value.manualReviewTracks) || !value.manualReviewTracks.every(isYTMusicSearchResult)))) return null;
  return {
    playlistId: value.playlistId,
    playlistUrl: value.playlistUrl,
    matched: value.matched,
    results: value.results,
    ...(value.unmatchedTracks !== undefined ? { unmatchedTracks: value.unmatchedTracks } : {}),
    ...(value.ambiguousTracks !== undefined ? { ambiguousTracks: value.ambiguousTracks } : {}),
    ...(value.manualReviewTracks !== undefined ? { manualReviewTracks: value.manualReviewTracks } : {}),
  };
}

async function spawnJson(
  command: string,
  args: string[],
  input: object,
  onProgress?: ProgressCallback,
  shouldCancel?: () => boolean,
): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    if (shouldCancel?.()) {
      reject(new DOMException('YouTube Music operation cancelled', 'AbortError'));
      return;
    }
    console.log(`🐍 Ejecutando: ${command} ${args.join(' ')}`);
    const proc = spawn(command, args, {
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    });
    let terminationRequested = false;
    const cancellationWatch = shouldCancel ? setInterval(() => {
      if (shouldCancel() && !terminationRequested) {
        terminationRequested = true;
        proc.kill('SIGTERM');
      }
    }, 20) : undefined;

    let stdout = '';
    let stdoutBuffer = '';
    let stderr = '';

    const processStdoutLine = (line: string) => {
      if (!line.trim()) return;

      try {
        const parsed: unknown = JSON.parse(line);
        if (!isScriptResponse(parsed)) return;
        if (typeof parsed.error === "string") {
          const error = parsed.code === "AUTHENTICATION_REQUIRED"
            ? new YTMusicAuthenticationRequiredError()
            : new Error(parsed.error);
          console.error(`[ytmusic] ${error.message}`);
          reject(error);
          return;
        }
        if (onProgress && isProgress(parsed.progress)) {
          onProgress(parsed.progress.current, parsed.progress.total, parsed.progress.artist, parsed.progress.title, parsed.progress.status);
        }
        if (
          parsed.results !== undefined ||
          parsed.playlistId !== undefined ||
          parsed.status !== undefined ||
          typeof parsed.success === "boolean"
        ) {
          resolve(parsed);
        }
      } catch {
        console.log(`[PROGRESS-DEBUG] chunk is not valid JSON`);
      }
    };

    const flushStdoutBuffer = () => {
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? '';
      lines.forEach(processStdoutLine);
    };

    // Enviar el input al script de Python
    proc.stdin.write(JSON.stringify(input));
    proc.stdin.end();

    proc.stdout.on('data', (data) => {
      const chunk = data.toString();
      stdout += chunk;
      stdoutBuffer += chunk;
      flushStdoutBuffer();
    });

    proc.stderr.on('data', (data: Buffer) => {
      const chunk = data.toString();
      stderr += chunk;
      for (const line of chunk.split('\n').filter((line) => line.trim())) {
        console.error(`[ytmusic] ${line}`);
      }
    });

    proc.on('error', (error) => {
      if (cancellationWatch) clearInterval(cancellationWatch);
      reject(error);
    });

    proc.on('close', (code) => {
      if (cancellationWatch) clearInterval(cancellationWatch);
      if (shouldCancel?.()) return reject(new DOMException('YouTube Music operation cancelled', 'AbortError'));
      processStdoutLine(stdoutBuffer);
      stdoutBuffer = '';

      if (code !== 0) {
        reject(new Error(`Process exited with code ${code}: ${stderr}`));
      }
    });
  });
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError";
}

async function runYtMusicScript(input: object, onProgress?: ProgressCallback, shouldCancel?: () => boolean): Promise<unknown> {
  const errors: string[] = [];

  if (PACKAGED_SEARCHER) {
    try {
      return await spawnJson(PACKAGED_SEARCHER, [], input, onProgress, shouldCancel);
    } catch (error) {
      if (error instanceof YTMusicAuthenticationRequiredError || isAbortError(error)) throw error;
      throw new Error(`Could not execute packaged ytmusic backend (${PACKAGED_SEARCHER}): ${(error as Error).message}`);
    }
  }

  for (const candidate of PYTHON_CANDIDATES) {
    try {
      return await spawnJson(candidate, [SEARCHER_SCRIPT], input, onProgress, shouldCancel);
    } catch (error) {
      if (error instanceof YTMusicAuthenticationRequiredError || isAbortError(error)) throw error;
      errors.push(`${candidate}: ${(error as Error).message}`);
    }
  }

  throw new Error(`Could not execute ytmusic backend. Attempts: ${errors.join(' | ')}`);
}

export async function convertWithYtMusic(
  tracks: Track[],
  playlistName: string,
  options: { dryRun: boolean, threshold?: number },
  onProgress?: ProgressCallback,
  shouldCancel?: () => boolean,
): Promise<YTMusicConversionResult> {
  const threshold = options.threshold ?? 0.6;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error("Conversion threshold must be a finite number from 0 to 1");
  }
  const result = await runYtMusicScript({
    action: 'search',
    createPlaylist: !options.dryRun,
    playlistName,
    tracks: tracks.map((track) => ({ artist: track.artist, title: track.title })),
    threshold,
  }, onProgress, shouldCancel);

  const conversionResult = toYTMusicConversionResult(result);
  if (!conversionResult) throw new Error("YouTube Music returned an invalid conversion result");
  return conversionResult;
}

export async function configureYtMusicBrowserAuth(headers: string): Promise<{ status: string; error?: string }> {
  const result = await runYtMusicScript({ action: "browser-auth", headers });
  if (!isScriptResponse(result) || typeof result.status !== "string") {
    return { status: "error", error: "YouTube Music returned an invalid authentication result" };
  }
  return { status: result.status, ...(typeof result.error === "string" ? { error: result.error } : {}) };
}

export async function searchSingleOnYtMusic(
  query: string,
  artist: string,
  title: string,
  threshold: number,
  offset: number,
): Promise<YTMusicManualSearchResult> {
  if (!Number.isInteger(offset) || offset < 0 || offset > 10 || offset % 5 !== 0) {
    throw new Error("Manual search offset must be 0, 5, or 10");
  }
  return toManualSearchResult(await runYtMusicScript({ action: "search-single", query, artist, title, threshold, offset }));
}

export async function addToPlaylistOnYtMusic(playlistId: string, videoIds: string[]): Promise<YTMusicAddToPlaylistResult> {
  return toAddToPlaylistResult(await runYtMusicScript({ action: "add-to-playlist", playlistId, videoIds }));
}