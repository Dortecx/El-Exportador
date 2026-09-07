import { isKana, isRomaji, toHiragana, toKana } from "wanakana";
import type { SpotifySourceTrack, SpotifyTrackCandidate, SpotifyTrackMatch } from "./types";

function normalize(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

function kanaOrRomaji(value: string): boolean {
  return isKana(value) || isRomaji(value);
}

/** Converts only known kana/rōmaji; callers must reject Kanji before using it. */
function kanaRomajiEquivalent(left: string, right: string): boolean {
  return kanaOrRomaji(left)
    && kanaOrRomaji(right)
    && normalize(toHiragana(toKana(left))).replaceAll(" ", "") === normalize(toHiragana(toKana(right))).replaceAll(" ", "");
}

function score(source: SpotifySourceTrack, candidate: SpotifyTrackCandidate): number {
  const titleMatches = normalize(source.title) === normalize(candidate.title);
  const artistMatches = candidate.artists.some((artist) => normalize(artist.name) === normalize(source.artist));
  const exactMatches = titleMatches && artistMatches;
  const kanaRomajiMatches = kanaRomajiEquivalent(source.title, candidate.title)
    && candidate.artists.some((artist) => kanaRomajiEquivalent(source.artist, artist.name));
  if (!exactMatches && !kanaRomajiMatches) return 0;
  if (!exactMatches) {
    if (source.durationMs === undefined || candidate.durationMs === undefined) return 0;
    return Math.abs(source.durationMs - candidate.durationMs) <= 5_000 ? 1 : 0;
  }
  if (source.durationMs === undefined || candidate.durationMs === undefined) return 0.9;
  return Math.abs(source.durationMs - candidate.durationMs) <= 5_000 ? 1 : 0.8;
}

export function buildSpotifySearchQuery(track: SpotifySourceTrack): string {
  return `${track.artist} ${track.title}`.trim();
}

function quotedSearchTerm(value: string): string {
  return `"${value.replace(/"/g, "\\\"")}"`;
}

function stripSafeSuffix(title: string): string {
  return title.replace(/\s+(?:[-–—]\s+)?(?:\([^()]*\)|\[[^\[\]]*\])\s*$/, "").trim();
}

/** Ordered query fallbacks are intentionally sequential within one track worker. */
export function buildSpotifySearchQueries(track: SpotifySourceTrack): string[] {
  const fullQuery = buildSpotifySearchQuery(track);
  const preciseQuery = `track:${quotedSearchTerm(track.title)} artist:${quotedSearchTerm(track.artist)}`;
  const strippedTitle = stripSafeSuffix(track.title);
  const suffixStrippedQuery = strippedTitle && strippedTitle !== track.title
    ? buildSpotifySearchQuery({ ...track, title: strippedTitle })
    : "";
  return [...new Set([fullQuery, preciseQuery, suffixStrippedQuery].filter(Boolean))];
}

export function matchSpotifyTrack(source: SpotifySourceTrack, candidates: SpotifyTrackCandidate[]): SpotifyTrackMatch {
  const scored = candidates
    .map((candidate) => ({ candidate, confidence: score(source, candidate) }))
    .filter((result) => result.confidence > 0)
    .sort((left, right) => right.confidence - left.confidence || left.candidate.uri.localeCompare(right.candidate.uri));
  const best = scored[0];
  if (!best) return { alternatives: [], candidate: null, confidence: 0, source, status: "unmatched" };
  const tied = scored.filter((result) => result.confidence === best.confidence);
  if (tied.length > 1) return { alternatives: tied.map((result) => result.candidate), candidate: null, confidence: best.confidence, source, status: "ambiguous" };
  return { alternatives: scored.slice(1).map((result) => result.candidate), candidate: best.candidate, confidence: best.confidence, source, status: "matched" };
}
