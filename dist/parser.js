import * as fs from "fs";
import * as path from "path";
const EXTENDED_M3U_HEADER = "#EXTM3U";
const EXTINF_PREFIX = "#EXTINF:";
const LEADING_NUMBER_REGEX = /^\d+(?:[-\s.]+\s*|\s+)/;
export function cleanTitle(title) {
    return title.replace(LEADING_NUMBER_REGEX, "").trim();
}
function parseDuration(durationStr) {
    const seconds = parseInt(durationStr, 10);
    return isNaN(seconds) ? undefined : seconds;
}
function parseExtInfLine(line) {
    const prefix = EXTINF_PREFIX;
    if (!line.startsWith(prefix))
        return null;
    const content = line.slice(prefix.length);
    const colonIndex = content.indexOf(",");
    if (colonIndex === -1)
        return null;
    const durationStr = content.slice(0, colonIndex);
    const afterComma = content.slice(colonIndex + 1).trim();
    const duration = parseDuration(durationStr);
    const dashIndex = afterComma.indexOf(" - ");
    if (dashIndex !== -1) {
        return {
            duration,
            artist: afterComma.slice(0, dashIndex).trim(),
            title: afterComma.slice(dashIndex + 3).trim(),
        };
    }
    return { duration, artist: "", title: afterComma };
}
function cleanFolderName(folder) {
    return folder
        .replace(/\s*(FLAC|HI-RES|MP3|AAC)\b.*/i, "")
        .replace(/\s*\[\s*(FLAC|24-\d+|HI-RES)[^\]]*\]/gi, "")
        .replace(/\s*\[[^\]]*\]\s*$/g, "")
        .replace(/\s*\(\s*\d+bit[^)]*\)/gi, "")
        .replace(/\s*\d+kHz\b.*/i, "")
        .replace(/\s*\(Single\)\s*/gi, "")
        .trim();
}
function hasJapaneseChars(str) {
    return /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/.test(str);
}
function extractFromPath(filePath) {
    const parts = filePath.replace(/\\/g, "/").split("/").filter((p) => p.length > 0);
    const fileName = parts[parts.length - 1].replace(/\.[^.]+$/, "");
    const folderName = parts.length > 1 ? parts[parts.length - 2] : "";
    const fileTitle = fileName.replace(/^\d+[\s\-\.]+\s*/, "").trim();
    if (!folderName) {
        const titleDashMatch = fileTitle.match(/^(.+?)\s+[-–—]\s+(.+)$/);
        if (titleDashMatch) {
            return { artist: titleDashMatch[1].trim(), title: titleDashMatch[2].trim() };
        }
        return { title: fileTitle || fileName };
    }
    const folder = cleanFolderName(folderName);
    const japSlashMatch = folder.match(/^(.+?)\s*[／/]\s*(.+)$/);
    if (japSlashMatch) {
        const beforeSlash = japSlashMatch[1].trim();
        const afterSlash = japSlashMatch[2].trim();
        const bracketMatch = afterSlash.match(/^「([^」]+)」/);
        if (bracketMatch) {
            return { artist: beforeSlash, title: fileTitle || bracketMatch[1] };
        }
        return { artist: afterSlash, title: fileTitle };
    }
    const dashMatch = folder.match(/^(.+?)\s+[-–—]\s+(.+)$/);
    if (dashMatch) {
        const artist = dashMatch[1].trim();
        let title = dashMatch[2].trim();
        if (hasJapaneseChars(title)) {
            const parenMatch = title.match(/\(([^)]+)\)$/);
            if (parenMatch && hasJapaneseChars(parenMatch[1])) {
                return { artist, title: parenMatch[1] };
            }
        }
        const cleanedFileTitle = fileTitle.replace(new RegExp(`^${artist.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[-–—]\\s*`, 'i'), '').trim();
        return { artist, title: cleanedFileTitle || title };
    }
    const titleDashMatch = fileTitle.match(/^(.+?)\s+[-–—]\s+(.+)$/);
    if (titleDashMatch) {
        return { artist: titleDashMatch[1].trim(), title: titleDashMatch[2].trim() };
    }
    return { title: fileTitle || folderName };
}
function isCommentOrBlank(line) {
    const trimmed = line.trim();
    return trimmed === "" || (trimmed.startsWith("#") && !trimmed.startsWith(EXTINF_PREFIX));
}
export function isValidM3UFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return ext === ".m3u" || ext === ".m3u8";
}
export function validateFilePath(filePath) {
    if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
    }
    if (!isValidM3UFile(filePath)) {
        throw new Error(`Expected .m3u or .m3u8 file`);
    }
}
export function parseM3U(content, isExtended) {
    const lines = content.split(/\r?\n/);
    const tracks = [];
    let pendingExtInf = null;
    for (const line of lines) {
        if (isExtended && line.startsWith(EXTENDED_M3U_HEADER))
            continue;
        if (isExtended && line.startsWith(EXTINF_PREFIX)) {
            pendingExtInf = parseExtInfLine(line);
            continue;
        }
        if (isCommentOrBlank(line))
            continue;
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
        }
        else {
            const { artist, title } = extractFromPath(file);
            tracks.push({ artist: artist || "", title, file, pathContext });
        }
    }
    return tracks;
}
export function detectFormat(content) {
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === "")
            continue;
        if (trimmed.startsWith(EXTENDED_M3U_HEADER) || trimmed.startsWith(EXTINF_PREFIX)) {
            return "extended";
        }
        return "standard";
    }
    return "standard";
}
export function parseFile(filePath) {
    validateFilePath(filePath);
    const content = fs.readFileSync(filePath, "utf-8");
    const format = detectFormat(content);
    const tracks = parseM3U(content, format === "extended");
    if (tracks.length === 0) {
        throw new Error("No tracks found in M3U file");
    }
    return { tracks, format };
}
//# sourceMappingURL=parser.js.map