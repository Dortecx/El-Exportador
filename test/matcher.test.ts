import { describe, it, expect } from "vitest";
import {
  buildQuery,
  levenshteinRatio,
  calculateConfidence,
  classifyMatch,
  normalizeTitle,
  parseDuration,
} from "../src/matcher.js";
import { Track, YouTubeItem } from "../src/types.js";

describe("Matcher", () => {
  describe("buildQuery", () => {
    it("should build query with artist and title", () => {
      const track: Track = { artist: "Pink Floyd", title: "Comfortably Numb", file: "/test.mp3" };
      expect(buildQuery(track)).toBe("Pink Floyd - Comfortably Numb");
    });

    it("should build query with title only when no artist", () => {
      const track: Track = { artist: "", title: "Comfortably Numb", file: "/test.mp3" };
      expect(buildQuery(track)).toBe("Comfortably Numb");
    });

    it("should build query with undefined artist", () => {
      const track: Track = { artist: "", title: "Space Oddity", file: "/test.mp3" };
      expect(buildQuery(track)).toBe("Space Oddity");
    });
  });

  describe("levenshteinRatio", () => {
    it("should return 1.0 for identical strings", () => {
      expect(levenshteinRatio("hello", "hello")).toBe(1.0);
    });

    it("should return 1.0 for same strings with different case", () => {
      expect(levenshteinRatio("Hello", "HELLO")).toBe(1.0);
    });

    it("should return 0.0 for empty strings", () => {
      expect(levenshteinRatio("", "hello")).toBe(0.0);
      expect(levenshteinRatio("hello", "")).toBe(0.0);
    });

    it("should calculate correct ratio for similar strings", () => {
      const ratio = levenshteinRatio("hello", "hallo");
      expect(ratio).toBeGreaterThan(0.5);
      expect(ratio).toBeLessThan(1.0);
    });

    it("should return 0.0 for completely different strings", () => {
      const ratio = levenshteinRatio("abc", "xyz");
      expect(ratio).toBe(0.0);
    });
  });

  describe("normalizeTitle", () => {
    it("should remove (official) suffix", () => {
      expect(normalizeTitle("Song Title (Official Video)")).toBe("song title");
    });

    it("should remove (lyric) suffix", () => {
      expect(normalizeTitle("Song Title (Lyric Video)")).toBe("song title");
    });

    it("should remove [official] bracket suffix", () => {
      expect(normalizeTitle("Song Title [Official Audio]")).toBe("song title");
    });

    it("should handle multiple parentheticals", () => {
      expect(normalizeTitle("Song (Remastered) (2020)")).toBe("song remastered 2020");
    });

    it("should remove special characters", () => {
      expect(normalizeTitle("Song - Title!")).toBe("song title");
    });

    it("should collapse whitespace", () => {
      expect(normalizeTitle("Song   Title")).toBe("song title");
    });
  });

  describe("parseDuration", () => {
    it("should parse PT format", () => {
      expect(parseDuration("PT3M45S")).toBe(225);
    });

    it("should parse PT with hours", () => {
      expect(parseDuration("PT1H30M45S")).toBe(5445);
    });

    it("should parse PT with only minutes", () => {
      expect(parseDuration("PT5M")).toBe(300);
    });

    it("should parse PT with only seconds", () => {
      expect(parseDuration("PT45S")).toBe(45);
    });

    it("should return undefined for invalid format", () => {
      expect(parseDuration("invalid")).toBeUndefined();
      expect(parseDuration("")).toBeUndefined();
      expect(parseDuration(undefined)).toBeUndefined();
    });
  });

  describe("calculateConfidence", () => {
    it("should give high score for exact match", () => {
      const track: Track = { artist: "Pink Floyd", title: "Comfortably Numb", file: "/test.mp3" };
      const item: YouTubeItem = {
        videoId: "abc123",
        title: "Comfortably Numb",
        channelTitle: "Pink Floyd",
        thumbnailUrl: "",
      };

      const score = calculateConfidence(track, item, track.title);
      expect(score).toBeGreaterThanOrEqual(0.70);
    });

    it("should give high score for match with (official) suffix", () => {
      const track: Track = { artist: "Beatles", title: "Hey Jude", file: "/test.mp3" };
      const item: YouTubeItem = {
        videoId: "abc123",
        title: "The Beatles - Hey Jude (Official Video)",
        channelTitle: "The Beatles",
        thumbnailUrl: "",
      };

      const score = calculateConfidence(track, item, track.title);
      expect(score).toBeGreaterThanOrEqual(0.60);
    });

    it("should give low score for generic title", () => {
      const track: Track = { artist: "", title: "Love", file: "/test.mp3" };
      const item: YouTubeItem = {
        videoId: "abc123",
        title: "Love - Kendrick Lamar",
        channelTitle: "Kendrick Lamar",
        thumbnailUrl: "",
      };

      const score = calculateConfidence(track, item, track.title);
      expect(score).toBeLessThan(0.5);
    });

    it("should factor duration match", () => {
      const track: Track = { artist: "Beatles", title: "Hey Jude", duration: 430, file: "/test.mp3" };
      const item: YouTubeItem = {
        videoId: "abc123",
        title: "The Beatles - Hey Jude",
        channelTitle: "The Beatles",
        duration: "PT7M10S",
        thumbnailUrl: "",
      };

      const scoreWithDuration = calculateConfidence(track, item, track.title);
      expect(scoreWithDuration).toBeGreaterThanOrEqual(0.70);
    });
  });

  describe("classifyMatch", () => {
    it("should classify as matched when >= threshold", () => {
      expect(classifyMatch(0.80, 0.75)).toBe("matched");
      expect(classifyMatch(0.75, 0.75)).toBe("matched");
    });

    it("should classify as ambiguous when between 0.40 and threshold", () => {
      expect(classifyMatch(0.74, 0.75)).toBe("ambiguous");
      expect(classifyMatch(0.50, 0.75)).toBe("ambiguous");
      expect(classifyMatch(0.40, 0.75)).toBe("ambiguous");
    });

    it("should classify as unmatched when < 0.40", () => {
      expect(classifyMatch(0.39, 0.75)).toBe("unmatched");
      expect(classifyMatch(0.20, 0.75)).toBe("unmatched");
      expect(classifyMatch(0.0, 0.75)).toBe("unmatched");
    });

    it("should respect custom threshold", () => {
      expect(classifyMatch(0.60, 0.50)).toBe("matched");
      expect(classifyMatch(0.55, 0.60)).toBe("ambiguous");
    });
  });
});
