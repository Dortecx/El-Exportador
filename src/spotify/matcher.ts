import type { SpotifySourceTrack, SpotifyTrackCandidate, SpotifyTrackMatch } from "./types";

function normalize(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

function score(source: SpotifySourceTrack, candidate: SpotifyTrackCandidate): number {
  const titleMatches = normalize(source.title) === normalize(candidate.title);
  const artistMatches = candidate.artists.some((artist) => normalize(artist.name) === normalize(source.artist));
  if (!titleMatches || !artistMatches) return 0;
  if (source.durationMs === undefined || candidate.durationMs === undefined) return 0.9;
  return Math.abs(source.durationMs - candidate.durationMs) <= 5_000 ? 1 : 0.8;
}

export function buildSpotifySearchQuery(track: SpotifySourceTrack): string {
  return `${track.artist} ${track.title}`.trim();
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
