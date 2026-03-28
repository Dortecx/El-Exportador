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

function cleanTrailingBracket(str: string): string {
  return str.replace(/\s*\[\s*$/, "").trim();
}

function removeDuplicateArtistFromTitle(artist: string, title: string): string {
  if (!artist || !title) return title;
  const artistNorm = artist.replace(/\s+/g, " ").trim();
  const titleNorm = title.replace(/\s+/g, " ").trim();
  const escaped = artistNorm.split(/\s+/).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
  const pattern = new RegExp(`^${escaped}\\s*[-\u2013\u2014]\\s*`, "i");
  return titleNorm.replace(pattern, "").trim();
}

function parseExtInfLine(line: string): { duration?: number; artist: string; title: string } | null {
  if (!line.startsWith(EXTINF_PREFIX)) return null;
  const content = line.slice(EXTINF_PREFIX.length);
  const colonIndex = content.indexOf(",");
  if (colonIndex === -1) return null;
  const duration = parseDuration(content.slice(0, colonIndex));
  const afterComma = content.slice(colonIndex + 1).trim();
  const dashIndex = afterComma.indexOf(" - ");
  if (dashIndex !== -1) {
    let artist = cleanTrailingBracket(afterComma.slice(0, dashIndex).trim());
    let title = removeDuplicateArtistFromTitle(artist, afterComma.slice(dashIndex + 3).trim());
    return { duration, artist, title };
  }
  return { duration, artist: "", title: afterComma };
}

function cleanFolderName(folder: string): string {
  return folder
    .replace(/\s*(FLAC|HI-RES|MP3|AAC)\b.*/i, "")
    .replace(/\s*\[\s*(FLAC|24-\d+|HI-RES)[^\]]*\]/gi, "")
    .replace(/\s*\[[^\]]*\]\s*$/g, "")
    .replace(/\s*\(\s*\d+bit[^)]*\)/gi, "")
    .replace(/\s*\d+kHz\b.*/i, "")
    .replace(/\s*\(Single\)\s*/gi, "")
    .trim();
}

// Matches: "Artist - Title" with normal dash, en-dash, or em-dash
const DASH_REGEX = /^(.+?)\s+[-\u2013\u2014]\s+(.+)$/;
// Matches Japanese full-width slash or regular /
const JAP_SLASH_REGEX = /^(.+?)\s*[\uff0f/]\s*(.+)$/;
// Matches Japanese corner bracket title
const CORNER_BRACKET_REGEX = /^\u300c([^\u300d]+)\u300d/;

function extractFromPath(filePath: string): { artist?: string; title: string } {
  const parts = filePath.replace(/\\/g, "/").split("/").filter((p) => p.length > 0);
  const fileName = parts[parts.length - 1].replace(/\.[^.]+$/, "");
  const folderName = parts.length > 1 ? parts[parts.length - 2] : "";
  const fileTitle = cleanTrailingBracket(fileName.replace(/^\d+[\s\-\.]+\s*/, "").trim());

  if (!folderName) {
    const m = fileTitle.match(DASH_REGEX);
    if (m) return { artist: m[1].trim(), title: m[2].trim() };
    return { title: fileTitle || fileName };
  }

  const folder = cleanFolderName(folderName);

  // Pattern: "Text／Artist" or "「Title」TVアニメ／Artist"
  const japSlashMatch = folder.match(JAP_SLASH_REGEX);
  if (japSlashMatch) {
    const beforeSlash = japSlashMatch[1].trim();
    const afterSlash = japSlashMatch[2].trim();

    // "Info／「Title」..." — artist is beforeSlash
    const bracketMatch = afterSlash.match(CORNER_BRACKET_REGEX);
    if (bracketMatch) {
      return { artist: cleanTrailingBracket(beforeSlash), title: fileTitle || bracketMatch[1] };
    }

    // "Info／Artist" — artist is afterSlash
    return { artist: cleanTrailingBracket(afterSlash), title: fileTitle };
  }

  // Pattern: "Artist - FolderTitle" with any dash variant
  const dashMatch = folder.match(DASH_REGEX);
  if (dashMatch) {
    const artist = cleanTrailingBracket(dashMatch[1].trim());
    const cleanedTitle = removeDuplicateArtistFromTitle(artist, fileTitle);
    return { artist, title: cleanedTitle || fileTitle };
  }

  // Fallback: try extracting from fileTitle itself
  const titleDashMatch = fileTitle.match(DASH_REGEX);
  if (titleDashMatch) {
    return { artist: titleDashMatch[1].trim(), title: titleDashMatch[2].trim() };
  }

  return { title: fileTitle || folderName };
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
  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  if (!isValidM3UFile(filePath)) throw new Error(`Expected .m3u or .m3u8 file`);
}

export function parseM3U(content: string, isExtended: boolean): Track[] {
  const lines = content.split(/\r?\n/);
  const tracks: Track[] = [];
  let pendingExtInf: { duration?: number; artist: string; title: string } | null = null;

  for (const line of lines) {
    if (isExtended && line.startsWith(EXTENDED_M3U_HEADER)) continue;
    if (isExtended && line.startsWith(EXTINF_PREFIX)) {
      pendingExtInf = parseExtInfLine(line);
      continue;
    }
    if (isCommentOrBlank(line)) continue;

    const file = line.trim();
    const parts = file.replace(/\\/g, "/").split("/").filter((p) => p.length > 0);
    const folders = parts.slice(0, -1);
    const filename = parts[parts.length - 1].replace(/\.[^.]+$/, "");
    const pathContext = { folders, filename };

    if (isExtended && pendingExtInf) {
      tracks.push({
        artist: pendingExtInf.artist,
        title: cleanTitle(pendingExtInf.title),
        duration: pendingExtInf.duration,
        file,
        pathContext,
      });
      pendingExtInf = null;
    } else {
      const { artist, title } = extractFromPath(file);
      tracks.push({ artist: artist || "", title, file, pathContext });
    }
  }

  return tracks;
}

export function detectFormat(content: string): "extended" | "standard" {
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (trimmed.startsWith(EXTENDED_M3U_HEADER) || trimmed.startsWith(EXTINF_PREFIX)) return "extended";
    return "standard";
  }
  return "standard";
}

export function parseFile(filePath: string): ParsedM3UResult {
  validateFilePath(filePath);
  const content = fs.readFileSync(filePath, "utf-8");
  const format = detectFormat(content);
  const tracks = parseM3U(content, format === "extended");
  if (tracks.length === 0) throw new Error("No tracks found in M3U file");
  return { tracks, format };
}