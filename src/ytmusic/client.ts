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
  const result = await runYtMusicScript({ action: 'validate-auth' });
  if (result?.status === 'valid' || result?.status === 'missing' || result?.status === 'invalid' || result?.status === 'unexpected_failure') {
    return { status: result.status, ...(typeof result.reason === 'string' ? { reason: result.reason } : {}) };
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

async function spawnJson(
  command: string,
  args: string[],
  input: object,
  onProgress?: ProgressCallback
): Promise<any> {
  return new Promise((resolve, reject) => {
    console.log(`🐍 Ejecutando: ${command} ${args.join(' ')}`);
    const proc = spawn(command, args, {
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    });

    let stdout = '';
    let stdoutBuffer = '';
    let stderr = '';

    const processStdoutLine = (line: string) => {
      if (!line.trim()) return;

      try {
        const parsed = JSON.parse(line);
        if (parsed.error) {
          const error = parsed.code === 'AUTHENTICATION_REQUIRED'
            ? new YTMusicAuthenticationRequiredError()
            : new Error(String(parsed.error));
          console.error(`[ytmusic] ${error.message}`);
          reject(error);
          return;
        }
        if (parsed.progress && onProgress) {
          const p = parsed.progress;
          onProgress(p.current, p.total, p.artist, p.title, p.status);
        }
        if (
          parsed.results !== undefined ||
          parsed.playlistId !== undefined ||
          parsed.status !== undefined ||
          typeof parsed.success === 'boolean'
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

    proc.stderr.on('data', (data) => {
      const chunk = data.toString();
      stderr += chunk;
      for (const line of chunk.split('\n').filter((line) => line.trim())) {
        console.error(`[ytmusic] ${line}`);
      }
    });

    proc.on('error', (error) => reject(error));

    proc.on('close', (code) => {
      processStdoutLine(stdoutBuffer);
      stdoutBuffer = '';

      if (code !== 0) {
        reject(new Error(`Process exited with code ${code}: ${stderr}`));
      }
    });
  });
}

async function runYtMusicScript(input: object, onProgress?: ProgressCallback): Promise<any> {
  const errors: string[] = [];

  if (PACKAGED_SEARCHER) {
    try {
      return await spawnJson(PACKAGED_SEARCHER, [], input, onProgress);
    } catch (error) {
      if (error instanceof YTMusicAuthenticationRequiredError) throw error;
      throw new Error(`Could not execute packaged ytmusic backend (${PACKAGED_SEARCHER}): ${(error as Error).message}`);
    }
  }

  for (const candidate of PYTHON_CANDIDATES) {
    try {
      return await spawnJson(candidate, [SEARCHER_SCRIPT], input, onProgress);
    } catch (error) {
      if (error instanceof YTMusicAuthenticationRequiredError) throw error;
      errors.push(`${candidate}: ${(error as Error).message}`);
    }
  }

  throw new Error(`Could not execute ytmusic backend. Attempts: ${errors.join(' | ')}`);
}

export async function convertWithYtMusic(
  tracks: Track[],
  playlistName: string,
  options: { dryRun: boolean, threshold?: number },
  onProgress?: ProgressCallback
): Promise<YTMusicConversionResult> {
  const result = await runYtMusicScript({
    action: 'search',
    createPlaylist: !options.dryRun,
    playlistName,
    tracks: tracks.map((track) => ({ artist: track.artist, title: track.title })),
    threshold: options.threshold || 0.6
  }, onProgress);

  return result as YTMusicConversionResult;
}

export async function configureYtMusicBrowserAuth(headers: string): Promise<{ status: string; error?: string }> {
  return runYtMusicScript({ action: "browser-auth", headers });
}

export async function searchSingleOnYtMusic(
  query: string,
  artist: string,
  title: string,
  threshold: number,
  offset: number,
): Promise<any> {
  if (!Number.isInteger(offset) || offset < 0 || offset > 10 || offset % 5 !== 0) {
    throw new Error('Manual search offset must be 0, 5, or 10');
  }
  return runYtMusicScript({ action: 'search-single', query, artist, title, threshold, offset });
}

export async function addToPlaylistOnYtMusic(playlistId: string, videoIds: string[]): Promise<any> {
  return runYtMusicScript({ action: 'add-to-playlist', playlistId, videoIds });
}