import { describe, it, expect } from "vitest";
import { parseM3U as parseM3UResult, detectFormat, isValidM3UFile, validateFilePath, cleanTitle } from "../src/parser.js";
import * as path from "path";
import * as fs from "fs";

const FIXTURES_DIR = path.join(import.meta.dirname, "fixtures");
const parseM3U = (content: string, isExtended: boolean) => parseM3UResult(content, isExtended).tracks;

describe("Parser", () => {
  describe("cleanTitle", () => {
    it("should remove leading track numbers like '01.'", () => {
      expect(cleanTitle("01. Song Title")).toBe("Song Title");
    });

    it("should remove leading track numbers like '01 -'", () => {
      expect(cleanTitle("01 - Song Title")).toBe("Song Title");
    });

    it("should remove leading track numbers like '05 - '", () => {
      expect(cleanTitle("05 - Song Title").trim()).toBe("Song Title");
    });

    it("should remove leading track numbers with dots", () => {
      expect(cleanTitle("01... Song Title")).toBe("Song Title");
    });

    it("should not modify titles without track numbers", () => {
      expect(cleanTitle("Song Title")).toBe("Song Title");
    });

    it("should handle track number inside filename", () => {
      expect(cleanTitle("01. Pink Floyd - Comfortably Numb")).toBe("Pink Floyd - Comfortably Numb");
    });
  });

  describe("detectFormat", () => {
    it("should detect extended format with EXTM3U header", () => {
      const content = "#EXTM3U\n#EXTINF:180,Pink Floyd - Comfortably Numb\n/home/user/music.mp3";
      expect(detectFormat(content)).toBe("extended");
    });

    it("should detect extended format with EXTINF line", () => {
      const content = "#EXTINF:180,Pink Floyd - Comfortably Numb\n/home/user/music.mp3";
      expect(detectFormat(content)).toBe("extended");
    });

    it("should detect standard format for plain file paths", () => {
      const content = "/home/user/music.mp3\n/home/user/music2.mp3";
      expect(detectFormat(content)).toBe("standard");
    });

    it("should return standard for empty content", () => {
      expect(detectFormat("")).toBe("standard");
    });

    it("should return standard for comments only", () => {
      const content = "# Comment\n# Another comment\n";
      expect(detectFormat(content)).toBe("standard");
    });
  });

  describe("parseM3U - Extended Format", () => {
    it("returns tracks and an optional playlist name", () => {
      const result = parseM3UResult("#EXTM3U\n#PLAYLIST: Favorites\n#EXTINF:180,Artist - Song\n/song.mp3", true);

      expect(result).toEqual({
        playlistName: "Favorites",
        tracks: [expect.objectContaining({ artist: "Artist", title: "Song" })],
      });
    });

    it("should parse extended M3U with artist and title", () => {
      const content = `#EXTM3U
#EXTINF:245,Pink Floyd - Comfortably Numb
/home/music/pink_floyd.mp3`;

      const tracks = parseM3U(content, true);

      expect(tracks).toHaveLength(1);
      expect(tracks[0]).toEqual({
        artist: "Pink Floyd",
        title: "Comfortably Numb",
        duration: 245,
        file: "/home/music/pink_floyd.mp3",
        pathContext: {
          folders: ["home", "music"],
          filename: "pink_floyd",
        },
      });
    });

    it("should parse extended M3U with title only (no dash)", () => {
      const content = `#EXTM3U
#EXTINF:180,Comfortably Numb
/home/music/pink_floyd.mp3`;

      const tracks = parseM3U(content, true);

      expect(tracks).toHaveLength(1);
      expect(tracks[0]).toEqual({
        artist: "",
        title: "Comfortably Numb",
        duration: 180,
        file: "/home/music/pink_floyd.mp3",
        pathContext: {
          folders: ["home", "music"],
          filename: "pink_floyd",
        },
      });
    });

    it("should handle unicode characters", () => {
      const content = `#EXTM3U
#EXTINF:200,Björk - Army of Me
/home/music/bjork.mp3`;

      const tracks = parseM3U(content, true);

      expect(tracks).toHaveLength(1);
      expect(tracks[0].artist).toBe("Björk");
      expect(tracks[0].title).toBe("Army of Me");
    });

    it("should skip comments and blank lines", () => {
      const content = `#EXTM3U
# Comment line
#EXTINF:245,Pink Floyd - Comfortably Numb
/home/music/pink_floyd.mp3

# Another comment
/home/music/another.mp3`;

      const tracks = parseM3U(content, true);

      expect(tracks).toHaveLength(2);
    });
  });

  describe("parseM3U - Standard Format", () => {
    it("should extract Japanese title from folder parentheses", () => {
      const content = "YOASOBI - Yuusha (勇者)/01. titulo.flac";

      const tracks = parseM3U(content, false);

      expect(tracks).toHaveLength(1);
      expect(tracks[0]).toEqual({
        artist: "YOASOBI",
        title: "勇者",
        file: "YOASOBI - Yuusha (勇者)/01. titulo.flac",
        pathContext: {
          folders: ["YOASOBI - Yuusha (勇者)"],
          filename: "01. titulo",
        },
      });
    });

    it("should use filename title when folder has no Japanese in parentheses", () => {
      const content = "Mrs. Green Apple - lulu (24bit-96kHz)/lulu.flac";

      const tracks = parseM3U(content, false);

      expect(tracks).toHaveLength(1);
      expect(tracks[0].artist).toBe("Mrs. Green Apple");
      expect(tracks[0].title).toBe("lulu");
    });

    it("should extract title from filename with Artist - Title format", () => {
      const content = "Artist Album/LIVING DEAD.flac";

      const tracks = parseM3U(content, false);

      expect(tracks).toHaveLength(1);
      expect(tracks[0].title).toBe("LIVING DEAD");
    });

    it("should handle folder without artist separator", () => {
      const content = "/music/Simple Folder/Simple Folder.flac";

      const tracks = parseM3U(content, false);

      expect(tracks).toHaveLength(1);
      expect(tracks[0].artist).toBe("");
      expect(tracks[0].title).toBe("Simple Folder");
    });

    it("should skip comments and blank lines", () => {
      const content = `# Comment
/home/music/track1.mp3

/home/music/track2.mp3`;

      const tracks = parseM3U(content, false);

      expect(tracks).toHaveLength(2);
    });

    it("should extract artist from after slash in folder name", () => {
      const content = "Sousou no Frieren OP Theme - Haru／Yorushika/晴る.flac";

      const tracks = parseM3U(content, false);

      expect(tracks).toHaveLength(1);
      expect(tracks[0].artist).toBe("Yorushika");
      expect(tracks[0].title).toBe("晴る");
    });

    it("walks past metadata parents to use an artist-title ancestor while keeping the filename title", () => {
      const tracks = parseM3U("Yorushika - Haru / Sousou no Frieren OP Theme FLAC / 01 - 晴る.flac", false);

      expect(tracks[0]).toMatchObject({ artist: "Yorushika", title: "晴る" });
    });

    it("uses a simple artist ancestor after skipping nested metadata folders", () => {
      const tracks = parseM3U("SIX LOUNGE / metadata / 01 - title.flac", false);

      expect(tracks[0]).toMatchObject({ artist: "SIX LOUNGE", title: "title" });
    });

    it.each(["01", "02", "1.", "CD1", "Disc 2"])("skips track-number-only ancestor folder %s", (trackFolder) => {
      const tracks = parseM3U(`Artist Name / ${trackFolder} / metadata / 01 - Track.flac`, false);

      expect(tracks[0]).toMatchObject({ artist: "Artist Name", title: "Track" });
    });

    it("skips series and quality ancestors rather than treating them as artists", () => {
      const tracks = parseM3U("Artist Name / TV Anime Season 2 / FLAC / 01 - Track.flac", false);

      expect(tracks[0]).toMatchObject({ artist: "Artist Name", title: "Track" });
    });

    it("should prioritize a track-number-cleaned filename artist-title pair over slash folder metadata", () => {
      const tracks = parseM3U("Sousou no Frieren OP Theme - Haru／Yorushika/01. Artist Name - Song Name.flac", false);

      expect(tracks[0]).toMatchObject({ artist: "Artist Name", title: "Song Name" });
    });

    it("should retain the pre-slash artist when title folders end in series metadata", () => {
      const tracks = parseM3U("Artist - Title／TV Anime Season 2/track.flac", false);

      expect(tracks[0]).toMatchObject({ artist: "Artist", title: "track" });
    });

    it("should retain the pre-slash artist when artist folders end in series metadata", () => {
      const tracks = parseM3U("Artist／TV Anime Season 2/track.flac", false);

      expect(tracks[0]).toMatchObject({ artist: "Artist", title: "track" });
    });

    it("should retain the pre-slash artist when ED and EP are slash-side metadata", () => {
      const tracks = parseM3U("milet - Anytime Anywhere／Sousou no Frieren ED EP FLAC (24bit-48kHz)/01 - Anytime Anywhere.flac", false);

      expect(tracks[0]).toMatchObject({ artist: "milet", title: "Anytime Anywhere" });
    });

    it("should never use anime or quality suffixes as slash-path artists", () => {
      const tracks = parseM3U("Artist - Title／TVアニメ 24bit 96kHz/track.flac", false);

      expect(tracks[0].artist).toBe("Artist");
    });

    it("should handle em dash as separator", () => {
      const content = "amazarashi – Sayonaragokko/Sayonaragokko.flac";

      const tracks = parseM3U(content, false);

      expect(tracks).toHaveLength(1);
      expect(tracks[0].artist).toBe("amazarashi");
      expect(tracks[0].title).toBe("Sayonaragokko");
    });

    it("should remove trailing bracket from artist name", () => {
      const content = `#EXTM3U
#EXTINF:245,Yorushika [ - 雨と言おう
/home/music/yorushika.flac`;

      const tracks = parseM3U(content, true);

      expect(tracks).toHaveLength(1);
      expect(tracks[0].artist).toBe("Yorushika");
      expect(tracks[0].title).toBe("雨と言おう");
    });

    it("should remove duplicate artist from title when duplicated in English and Japanese", () => {
      const content = `#EXTM3U
#EXTINF:200,Luck Life - ラックライフ - しるし
/home/music/lucklife.flac`;

      const tracks = parseM3U(content, true);

      expect(tracks).toHaveLength(1);
      expect(tracks[0].artist).toBe("Luck Life");
      expect(tracks[0].title).toBe("ラックライフ - しるし");
    });
  });

  describe("isValidM3UFile", () => {
    it("should return true for .m3u files", () => {
      expect(isValidM3UFile("playlist.m3u")).toBe(true);
    });

    it("should return true for .m3u8 files", () => {
      expect(isValidM3UFile("playlist.m3u8")).toBe(true);
    });

    it("should return true for uppercase extensions", () => {
      expect(isValidM3UFile("playlist.M3U")).toBe(true);
    });

    it("should return false for other extensions", () => {
      expect(isValidM3UFile("playlist.txt")).toBe(false);
      expect(isValidM3UFile("playlist.mp3")).toBe(false);
      expect(isValidM3UFile("playlist")).toBe(false);
    });
  });

  describe("validateFilePath", () => {
    const testFile = path.join(FIXTURES_DIR, "extended.m3u");

    it("should not throw for valid existing .m3u file", () => {
      expect(() => validateFilePath(testFile)).not.toThrow();
    });

    it("should throw for non-existent file", () => {
      expect(() => validateFilePath("/non/existent/file.m3u")).toThrow("File not found");
    });

    it("should throw for wrong extension", () => {
      const txtFile = path.join(FIXTURES_DIR, "test.txt");
      fs.writeFileSync(txtFile, "test");
      try {
        expect(() => validateFilePath(txtFile)).toThrow("Expected .m3u or .m3u8 file");
      } finally {
        fs.unlinkSync(txtFile);
      }
    });
  });
});

describe("Fixture Files", () => {
  it("should parse extended.m3u fixture", () => {
    const content = fs.readFileSync(path.join(FIXTURES_DIR, "extended.m3u"), "utf-8");
    const tracks = parseM3U(content, true);

    expect(tracks.length).toBe(3);
    expect(tracks[0].artist).toBe("Pink Floyd");
    expect(tracks[0].title).toBe("Comfortably Numb");
    expect(tracks[0].duration).toBe(245);
  });

  it("should parse standard.m3u fixture", () => {
    const content = fs.readFileSync(path.join(FIXTURES_DIR, "standard.m3u"), "utf-8");
    const tracks = parseM3U(content, false);

    expect(tracks.length).toBe(4);
    expect(tracks[0].artist).toBe("Pink Floyd");
    expect(tracks[0].title).toBe("Comfortably Numb");
  });

  it("should handle unicode.m3u8 fixture", () => {
    const content = fs.readFileSync(path.join(FIXTURES_DIR, "unicode.m3u8"), "utf-8");
    const tracks = parseM3U(content, true);

    expect(tracks.length).toBe(3);
    expect(tracks[0].artist).toBe("Björk");
    expect(tracks[1].artist).toBe("José González");
  });

  it("should throw for empty.m3u fixture", () => {
    const content = fs.readFileSync(path.join(FIXTURES_DIR, "empty.m3u"), "utf-8");
    const tracks = parseM3U(content, true);

    expect(tracks.length).toBe(0);
  });
});
