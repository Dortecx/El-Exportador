import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import type { Track } from '../types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const YTMusicAuthFile = path.join(os.homedir(), '.config', 'm3u-to-ytmusic', 'ytmusic_auth.json');
// Use fixed path - works both in dev (tsx) and production
const SEARCHER_SCRIPT = 'C:/Users/Dom/Documents/Projects/El Exportador/m3u-to-ytmusic/src/ytmusic/searcher.py';

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
}

export type ProgressCallback = (current: number, total: number, artist: string, title: string, status: string) => void;

function getPythonCandidates(): string[] {
  const projectVenv = path.resolve(__dirname, '../../.venv/Scripts/python.exe');
  // Windows paths work better with spawn in WSL
  const eDiskPython = '/mnt/e/School/Python/Python311/python.exe';
  return [
    process.env.YTMUSIC_PYTHON_PATH,
    eDiskPython,
    projectVenv,
    'python',
    'py',
  ].filter((value): value is string => Boolean(value));
}

async function spawnJson(
  command: string,
  args: string[],
  input: object,
  onProgress?: ProgressCallback
): Promise<any> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      const chunk = data.toString();
      stdout += chunk;
      
      console.log(`[PROGRESS-DEBUG] client.ts: stdout chunk received: ${chunk.substring(0, 200)}`);
      
      const lines = chunk.split('\n').filter((l: string) => l.trim());
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          console.log(`[PROGRESS-DEBUG] client.ts: parsed JSON, keys: ${Object.keys(parsed).join(', ')}`);
          
          if (parsed.progress && onProgress) {
            const p = parsed.progress;
            console.log(`[PROGRESS-DEBUG] client.ts: calling onProgress callback with current=${p.current}, total=${p.total}, artist=${p.artist}, title=${p.title}, status=${p.status}`);
            onProgress(p.current, p.total, p.artist, p.title, p.status);
          }
        } catch {
          console.log(`[PROGRESS-DEBUG] client.ts: chunk is not valid JSON`);
        }
      }
    });

    proc.stderr.on('data', (data) => {
      const chunk = data.toString();
      if (!chunk.startsWith('DEBUG:') && !chunk.includes('Searching query:') && !chunk.includes('SUBSTRING CHECK:') && !chunk.includes('Got ')) {
        stderr += chunk;
      }
    });

    proc.on('error', (error) => reject(error));

    proc.on('close', (code) => {
      try {
        const stdoutLines = stdout.split('\n').filter((line) => line.trim());
        
        // Find the last JSON line with results or playlistId
        for (let i = stdoutLines.length - 1; i >= 0; i--) {
          try {
            const parsed = JSON.parse(stdoutLines[i]);
            if (parsed.results !== undefined || parsed.playlistId !== undefined) {
              resolve(parsed);
              return;
            }
          } catch { continue; }
        }
        
        // Fallback: try to parse any JSON in stdout
        const parsed = JSON.parse(stdout);
        resolve(parsed);
      } catch {
        // Only reject if there's a real error message
        if (stderr.trim() && !stderr.includes('DEBUG:') && stderr.length > 10) {
          reject(new Error(stderr || `Script exited with code ${code}`));
        } else if (code !== 0) {
          reject(new Error(`Script exited with code ${code}`));
        } else {
          reject(new Error('No valid result from script'));
        }
      }
    });

    proc.stdin.write(JSON.stringify(input));
    proc.stdin.end();
  });
}

export function checkYtMusicAvailable(): boolean {
  return true;
}

export async function runYtMusicScript(input: object, onProgress?: ProgressCallback): Promise<any> {
  const candidates = getPythonCandidates();
  const errors: string[] = [];

  for (const candidate of candidates) {
    try {
      const args = candidate.toLowerCase() === 'py' ? ['-3', SEARCHER_SCRIPT] : [SEARCHER_SCRIPT];
      return await spawnJson(candidate, args, input, onProgress);
    } catch (error) {
      errors.push(`${candidate}: ${(error as Error).message}`);
    }
  }

  throw new Error(`Could not execute ytmusic backend. Attempts: ${errors.join(' | ')}`);
}

export async function convertWithYtMusic(
  tracks: Track[],
  playlistName: string,
  options: { dryRun: boolean },
  onProgress?: ProgressCallback
): Promise<YTMusicConversionResult> {
  const result = await runYtMusicScript({
    action: 'search',
    createPlaylist: !options.dryRun,
    playlistName,
    tracks: tracks.map((track) => ({ artist: track.artist, title: track.title })),
  }, onProgress);

  return result as YTMusicConversionResult;
}

export async function searchSingleOnYtMusic(query: string): Promise<any> {
  return runYtMusicScript({ action: 'search-single', query });
}

export async function addToPlaylistOnYtMusic(playlistId: string, videoIds: string[]): Promise<any> {
  return runYtMusicScript({ action: 'add-to-playlist', playlistId, videoIds });
}