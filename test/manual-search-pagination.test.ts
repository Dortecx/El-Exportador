import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type ManualSearchState = {
  query: string;
  artist: string;
  title: string;
  threshold: number;
  offset: number;
  candidateCount: number;
  hasMore: boolean;
};

function loadNextManualSearch(states: Map<string, ManualSearchState>) {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const match = html.match(/function nextManualSearch\(trackId, query, artist, title\) \{[\s\S]*?(?=\n\s*function showManualSearchThreshold)/);
  if (!match) throw new Error("nextManualSearch was not found in public/index.html");

  return new Function("manualSearchStates", `${match[0]}; return nextManualSearch;`)(states);
}

describe("manual search pagination", () => {
  it("raises the threshold and resets to offset 0 after a full terminal page at offset 10", () => {
    const states = new Map<string, ManualSearchState>([["track-1", {
      query: "query",
      artist: "artist",
      title: "title",
      threshold: 0.30,
      offset: 10,
      candidateCount: 5,
      hasMore: false,
    }]]);

    const nextManualSearch = loadNextManualSearch(states);

    expect(nextManualSearch("track-1", "query", "artist", "title")).toEqual({
      threshold: 0.45,
      offset: 0,
      exhausted: false,
    });
  });

  it("stores each threshold advancement as an exact two-decimal value", () => {
    const states = new Map<string, ManualSearchState>();
    const nextManualSearch = loadNextManualSearch(states);
    const thresholds = [0.00, 0.15, 0.30, 0.45, 0.60];

    thresholds.slice(0, -1).forEach((threshold, index) => {
      states.set("track-1", {
        query: "query",
        artist: "artist",
        title: "title",
        threshold,
        offset: 10,
        candidateCount: 5,
        hasMore: false,
      });

      expect(nextManualSearch("track-1", "query", "artist", "title")).toEqual({
        threshold: thresholds[index + 1],
        offset: 0,
        exhausted: false,
      });
    });
  });

  it("never advances beyond offset 10 when stale pagination metadata reports more results", () => {
    const states = new Map<string, ManualSearchState>([["track-1", {
      query: "query",
      artist: "artist",
      title: "title",
      threshold: 0.45,
      offset: 10,
      candidateCount: 5,
      hasMore: true,
    }]]);

    const nextManualSearch = loadNextManualSearch(states);

    expect(nextManualSearch("track-1", "query", "artist", "title")).toEqual({
      threshold: 0.60,
      offset: 0,
      exhausted: false,
    });
  });
});
