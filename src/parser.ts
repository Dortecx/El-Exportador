import * as fs from "fs";
import * as path from "path";
import { Track, ParsedM3UResult } from "./types.js";

const EXTENDED_M3U_HEADER = "#EXTM3U";
const EXTINF_PREFIX = "#EXTINF:";

const LEADING_NUMBER_REGEX = /^\d+(?:[-\s.]+\s*|\s+)/;

export function cleanTitle(title: string): string {
  return title.replace(LEADING_NUMBER_REGEX, "").trim();
}

function parseDuration(durationStr: string): number | undefined {
  const seconds = parseInt(durationStr, 10);
  return isNaN(seconds) ? undefined : seconds;
}

function parseExtInfLine(line: string): { duration?: number; artist: string; title: string } | null {
  const prefix = EXTINF_PREFIX;
  if (!line.startsWith(prefix)) {
    return null;
  }

  const content = line.slice(prefix.length);
  const colonIndex = content.indexOf(",");
  if (colonIndex === -1) {
    return null;
  }

  const durationStr = content.slice(0, colonIndex);
  const afterComma = content.slice(colonIndex + 1).trim();

  const duration = parseDuration(durationStr);

  const dashIndex = afterComma.indexOf(" - ");
  if (dashIndex !== -1) {
    const artist = afterComma.slice(0, dashIndex).trim();
    const title = afterComma.slice(dashIndex + 3).trim();
    return { duration, artist, title };
  }

  return { duration, artist: "", title: afterComma };
}

function cleanFolderName(folderName: string): string {
  const JAPANESE_REGEX = /[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9faf\u3400-\u4dbf]/;
  
  let cleaned = folderName;
  
  cleaned = cleaned.replace(/\[[^\]]*\]/g, " ");
  cleaned = cleaned.replace(/(\([^)]*\))/g, (match) => {
    if (JAPANESE_REGEX.test(match)) {
      return match;
    }
    return " ";
  });
  
  cleaned = cleaned
    .replace(/\bFLAC\b/gi, "")
    .replace(/\bMP3\b/gi, "")
    .replace(/\bWAV\b/gi, "")
    .replace(/\bHI-RES?\b/gi, "")
    .replace(/\b\d{2,4}kHz\b/gi, "")
    .replace(/\b\d{2}bit\b/gi, "")
    .replace(/\(\d+[.,]?\d*[-/]?\d*[kK]?Hz?\)/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned;
}

function extractTitleFromFilename(filename: string): { title: string; artist?: string } {
  const withoutExt = filename.replace(/\.[^.]+$/, "");
  let cleaned = withoutExt
    .replace(LEADING_NUMBER_REGEX, "")
    .replace(/\s+/g, " ")
    .trim();
  
  const cornerBracketsMatch = cleaned.match(/「([^」]+)」/);
  if (cornerBracketsMatch) {
    return { title: cornerBracketsMatch[1].trim() };
  }
  
  const dashMatch = cleaned.match(/^([^　\s].*?)\s*[-－–—]\s*(.+)$/);
  if (dashMatch) {
    return { title: dashMatch[2].trim(), artist: dashMatch[1].trim() };
  }
  
  return { title: cleaned };
}

function deriveTitleFromPath(filePath: string): { artist: string; title: string; pathContext: { folders: string[]; filename: string } } {
  const dir = path.dirname(filePath);
  const basename = path.basename(filePath);
  const withoutExt = basename.replace(/\.[^.]+$/, "");

  const folders = dir.split(/[\\/]/).filter(f => f.length > 0);
  const folderName = folders.length > 0 ? folders[folders.length - 1] : "";

  const { title: filenameTitle, artist: filenameArtist } = extractTitleFromFilename(withoutExt);
  
  let artist = "";
  let finalTitle = filenameTitle;

  if (folderName) {
    const cleanedFolder = cleanFolderName(folderName);
    
    const slashMatch = cleanedFolder.match(/\s*[\/／]\s*(.+)$/);
    if (slashMatch) {
      artist = slashMatch[1].trim();
    } else {
      const dashMatch = cleanedFolder.match(/^(.+?)\s*[-－–—]\s*(.+)$/);
      if (dashMatch) {
        artist = dashMatch[1].trim();
        
        const afterDash = dashMatch[2];
        const parenJapaneseMatch = afterDash.match(/\(([^)]+)\)/);
        if (parenJapaneseMatch) {
          const inside = parenJapaneseMatch[1];
          const hasJapanese = /[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9faf\u3400-\u4dbf]/.test(inside);
          if (hasJapanese && !/[a-zA-Z]/.test(inside)) {
            finalTitle = inside;
          }
        }
      }
    }
  }

  if (!artist && filenameArtist) {
    artist = filenameArtist;
  }

  return { artist, title: finalTitle, pathContext: { folders, filename: withoutExt } };
}

function isCommentOrBlank(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === "" || (trimmed.startsWith("#") && !trimmed.startsWith(EXTINF_PREFIX));
}

export function isValidM3UFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ext === ".m3u" || ext === ".m3u8";
}

export function validateFilePath(filePath: string): void {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  if (!isValidM3UFile(filePath)) {
    throw new Error(`Expected .m3u or .m3u8 file`);
  }
}

export function parseM3U(content: string, isExtended: boolean): Track[] {
  const lines = content.split(/\r?\n/);
  const tracks: Track[] = [];
  let pendingExtInf: { duration?: number; artist: string; title: string } | null = null;

  for (const line of lines) {
    if (isExtended && line.startsWith(EXTENDED_M3U_HEADER)) {
      continue;
    }

    if (isExtended && line.startsWith(EXTINF_PREFIX)) {
      pendingExtInf = parseExtInfLine(line);
      continue;
    }

    if (isCommentOrBlank(line)) {
      continue;
    }

    const file = line.trim();

    if (isExtended && pendingExtInf) {
      const { pathContext } = deriveTitleFromPath(file);
      tracks.push({
        artist: pendingExtInf.artist,
        title: cleanTitle(pendingExtInf.title),
        duration: pendingExtInf.duration,
        file,
        pathContext,
      });
      pendingExtInf = null;
    } else {
      const { artist, title, pathContext } = deriveTitleFromPath(file);
      tracks.push({ artist, title: cleanTitle(title), file, pathContext });
    }
  }

  return tracks;
}

export function detectFormat(content: string): "extended" | "standard" {
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") {
      continue;
    }
    if (trimmed.startsWith(EXTENDED_M3U_HEADER) || trimmed.startsWith(EXTINF_PREFIX)) {
      return "extended";
    }
    return "standard";
  }
  return "standard";
}

export function parseFile(filePath: string): ParsedM3UResult {
  validateFilePath(filePath);

  const content = fs.readFileSync(filePath, "utf-8");
  const format = detectFormat(content);
  const tracks = parseM3U(content, format === "extended");

  if (tracks.length === 0) {
    throw new Error("No tracks found in M3U file");
  }

  return { tracks, format };
}
