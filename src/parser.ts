import * as fs from "fs";
import * as path from "path";
import { Track, ParsedM3UResult } from "./types";

const EXTENDED_M3U_HEADER = "#EXTM3U";
const EXTINF_PREFIX = "#EXTINF:";
const PLAYLIST_PREFIX = "#PLAYLIST:";
const LEADING_NUMBER_REGEX = /^(?:(?:CD|Disc)\s*\d+\s*[-\u2013\u2014.]\s*|\d+(?:[-\s.]+\s*|\s+))/i;

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

function cleanArtistPrefix(artist: string): string {
  const cleaned = cleanTrailingBracket(artist);
  const trailingParenthesis = cleaned.match(/\s*\(([^)]*)\)\s*$/);
  if (trailingParenthesis && SLASH_METADATA_REGEX.test(trailingParenthesis[1])) {
    return cleaned.slice(0, trailingParenthesis.index).trim();
  }
  return cleaned;
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
const JAPANESE_PARENTHESIS_TITLE_REGEX = /\(([\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]+)\)/u;
const SLASH_METADATA_REGEX = /(?:\b(?:anime|tv|season|series|episode|cour|ost|soundtrack|flac|hi-res|mp3|aac|\d+\s*bit|\d+\s*k(?:hz)?|blu-?ray|op|ed|ep|theme|bonus\s+disc|(?:disc|cd)\s*\d+)\b|アニメ|シーズン|画質|品質)/i;
const LIBRARY_FOLDER_REGEX = /^(?:home|music|audio|downloads?|library|media|favorites|samsung favorites)$/i;
const TRACK_NUMBER_FOLDER_REGEX = /^(?:\d+\.?|CD\s*\d+|Disc\s*\d+)$/i;

function isTrackNumberOnlyFolder(folder: string): boolean {
  return TRACK_NUMBER_FOLDER_REGEX.test(folder.trim());
}

function isCrediblePostSlashArtist(beforeSlash: string, afterSlash: string): boolean {
  if (SLASH_METADATA_REGEX.test(afterSlash)) return false;
  const beforeDashMatch = beforeSlash.match(DASH_REGEX);
  if (beforeDashMatch && cleanArtistPrefix(beforeDashMatch[1]) !== cleanTrailingBracket(beforeDashMatch[1])) return false;
  return Boolean(beforeDashMatch || CORNER_BRACKET_REGEX.test(beforeSlash));
}

function findAncestorArtist(folders: string[]): string | undefined {
  // The immediate parent commonly carries release, series, or quality metadata.
  // Search older folders from nearest to farthest for an actual artist segment.
  for (let index = folders.length - 2; index >= 0; index--) {
    const rawFolder = folders[index];
    const folder = cleanFolderName(rawFolder);
    if (
      !folder
      || isTrackNumberOnlyFolder(folder)
      || SLASH_METADATA_REGEX.test(folder)
      || LIBRARY_FOLDER_REGEX.test(folder)
    ) continue;

    const dashMatch = folder.match(DASH_REGEX);
    if (dashMatch) return cleanArtistPrefix(dashMatch[1].trim());

    const slashMatch = folder.match(JAP_SLASH_REGEX);
    if (slashMatch) {
      const beforeSlash = slashMatch[1].trim();
      const afterSlash = slashMatch[2].trim();
      if (isCrediblePostSlashArtist(beforeSlash, afterSlash)) return cleanTrailingBracket(afterSlash);
      if (!SLASH_METADATA_REGEX.test(beforeSlash)) {
        return cleanTrailingBracket(beforeSlash.match(DASH_REGEX)?.[1].trim() || beforeSlash);
      }
      continue;
    }

    return cleanTrailingBracket(folder);
  }

  return undefined;
}

function extractFromPath(filePath: string): { artist?: string; title: string } {
  const parts = filePath.replace(/\\/g, "/").split("/").filter((p) => p.length > 0);
  const fileName = parts[parts.length - 1].replace(/\.[^.]+$/, "");
  const folderName = parts.length > 1 ? parts[parts.length - 2] : "";
  const isTrackNumberedFile = LEADING_NUMBER_REGEX.test(fileName.trim());
  const fileTitle = cleanTrailingBracket(cleanTitle(fileName.trim()));
  const filenameDashMatch = fileTitle.match(DASH_REGEX);

  // Track-numbered files carry only a title after the number. In particular, a
  // later dash can be part of the title rather than an artist-title separator.
  if (!isTrackNumberedFile && filenameDashMatch) {
    return { artist: filenameDashMatch[1].trim(), title: filenameDashMatch[2].trim() };
  }

  if (!folderName) {
    return { title: fileTitle || fileName };
  }

  const ancestorArtist = findAncestorArtist(parts.slice(0, -1));
  if (ancestorArtist) return { artist: ancestorArtist, title: fileTitle || fileName };

  const folder = cleanFolderName(folderName);

  // Keep the pre-slash artist unless the folder structure clearly identifies a
  // post-slash artist. Series, season, anime, and quality suffixes are metadata.
  const japSlashMatch = folder.match(JAP_SLASH_REGEX);
  if (japSlashMatch) {
    const beforeSlash = japSlashMatch[1].trim();
    const afterSlash = japSlashMatch[2].trim();
    const bracketMatch = beforeSlash.match(CORNER_BRACKET_REGEX);
    const beforeDashMatch = beforeSlash.match(DASH_REGEX);

    if (isCrediblePostSlashArtist(beforeSlash, afterSlash)) {
      return {
        artist: cleanTrailingBracket(afterSlash),
        title: fileTitle || bracketMatch?.[1] || beforeDashMatch?.[2].trim() || beforeSlash,
      };
    }

    return {
      artist: cleanArtistPrefix(beforeDashMatch?.[1].trim() || beforeSlash),
      title: fileTitle || beforeDashMatch?.[2].trim() || bracketMatch?.[1] || beforeSlash,
    };
  }

  // Prefer a Japanese title in folder parentheses over a generic filename.
  const japaneseParenthesisTitle = folderName.match(JAPANESE_PARENTHESIS_TITLE_REGEX)?.[1];
  // Pattern: "Artist - FolderTitle" with any dash variant
  const dashMatch = folder.match(DASH_REGEX);
  if (dashMatch) {
    const artist = cleanArtistPrefix(dashMatch[1].trim());
    const cleanedTitle = removeDuplicateArtistFromTitle(artist, fileTitle);
    return { artist, title: japaneseParenthesisTitle || cleanedTitle || fileTitle };
  }

  // A simple immediate folder is the artist for numbered library tracks, whose
  // filename must be kept intact as a title after removing the track number.
  if (isTrackNumberedFile && folder && !SLASH_METADATA_REGEX.test(folderName) && !LIBRARY_FOLDER_REGEX.test(folder)) {
    return { artist: cleanTrailingBracket(folder), title: fileTitle || fileName };
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

export function parseM3U(content: string, isExtended: boolean): { tracks: Track[], playlistName?: string } {
  const lines = content.split(/\r?\n/);
  const tracks: Track[] = [];
  let pendingExtInf: { duration?: number; artist: string; title: string } | null = null;
  let playlistName: string | undefined;

  for (const line of lines) {
    if (line.startsWith(PLAYLIST_PREFIX)) {
      playlistName = line.slice(PLAYLIST_PREFIX.length).trim();
      continue;
    }
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

  return { tracks, playlistName };
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
  const { tracks, playlistName } = parseM3U(content, format === "extended");
  if (tracks.length === 0) throw new Error("No tracks found in M3U file");
  return { tracks, format, playlistName };
}