#!/usr/bin/env node

import { Command } from "commander";
import chalk from "chalk";
import * as fs from "fs";
import * as path from "path";
import { OAuth2Client } from "google-auth-library";
import { parseFile } from "./parser.js";
import { matchTrack, AuthClient, simulateOfflineMatch } from "./matcher.js";
import { getAuthClient, validateAuth } from "./auth.js";
import { createPlaylistWithTracks, calculateQuotaUsage } from "./playlist.js";
import { loadConfig } from "./config.js";
import { Track, MatchResult, CliOptions } from "./types.js";

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

const VERSION = "1.0.0";

export async function runCli(): Promise<void> {
  const program = new Command();

  program
    .name("m3u-to-ytmusic")
    .description("Convert M3U playlists to YouTube Music")
    .version(VERSION)
    .argument("<file>", "Path to M3U or M3U8 file")
    .option("-n, --name <name>", "Playlist name on YouTube Music (default: filename)")
    .option("-i, --interactive", "Prompt for ambiguous matches")
    .option("--threshold <0-1>", "Match confidence threshold", (val) => parseFloat(val), 0.6)
    .option("-o, --output <file>", "Output JSON report to file")
    .option("-v, --verbose", "Show per-track search details")
    .option("--credentials <path>", "Path to credentials.json")
  .option("--dry-run", "Show matches without creating playlist")
    .option("--offline", "Simulate API responses with 0.8 confidence (no quota used)")
    .option("--token <path>", "Path to tokens.json")
    .addHelpText("after", `
Environment Variables:
  YOUTUBE_API_KEY    API key for dry-run mode (no OAuth2 required)

Examples:
  # Dry-run with API key (no auth needed)
  YOUTUBE_API_KEY=your_key m3u-to-ytmusic playlist.m3u --dry-run

  # Full mode with OAuth2
  m3u-to-ytmusic playlist.m3u --name "My Playlist"

  # Dry-run with OAuth2 (if no API key)
  m3u-to-ytmusic playlist.m3u --dry-run

  # Offline mode (simulated, no API calls)
  m3u-to-ytmusic playlist.m3u --dry-run --offline
`);

  program.parse();

  const opts = program.opts();
  const filePath = program.args[0] as string;

  if (!filePath) {
    console.error(chalk.red("Error: No file specified"));
    console.log("Usage: m3u-to-ytmusic <file.m3u> [options]");
    process.exit(1);
  }

  try {
    await run(filePath, {
      name: opts.name,
      interactive: opts.interactive,
      dryRun: opts.dryRun,
      offline: opts.offline,
      threshold: opts.threshold,
      output: opts.output,
      verbose: opts.verbose,
      credentials: opts.credentials,
      file: filePath,
    });
  } catch (error) {
    console.error(chalk.red(`Error: ${(error as Error).message}`));
    process.exit(1);
  }
}

export async function run(
  filePath: string,
  options: Partial<CliOptions> & { file: string }
): Promise<void> {
  console.log(chalk.blue("\n=== M3U to YouTube Music ===\n"));

  console.log(chalk.gray("Parsing M3U file..."));
  const { tracks, format } = parseFile(filePath);
  console.log(
    chalk.gray(`Found ${tracks.length} tracks (${format} format)\n`)
  );

  const playlistName =
    options.name ?? path.basename(filePath, path.extname(filePath));

  if (options.dryRun) {
    await runDryRun(tracks, options.threshold ?? 0.6, options.verbose ?? false, options.offline ?? false);
    return;
  }

  if (!YOUTUBE_API_KEY) {
    throw new Error(
      "YOUTUBE_API_KEY environment variable is required for full mode.\n" +
      "Set it with: export YOUTUBE_API_KEY=your_api_key"
    );
  }

  const config = loadConfig(options.credentials);
  config.matchThreshold = options.threshold ?? config.matchThreshold;

  let oauth2Auth: AuthClient | undefined;
  console.log(chalk.gray("Attempting OAuth2 for playlist creation..."));
  try {
    const auth = await getAuthClient(options.credentials);
    const isValid = await validateAuth(auth);
    if (isValid) {
      oauth2Auth = auth;
      console.log(chalk.green("OAuth2 available for playlist creation.\n"));
    } else {
      console.log(chalk.yellow("OAuth2 not available. Playlist creation will be skipped.\n"));
    }
  } catch {
    console.log(chalk.yellow("OAuth2 authentication skipped. Playlist creation will be skipped.\n"));
  }

  console.log(chalk.gray("Matching tracks with YouTube..."));
  const matchResults: MatchResult[] = [];

  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i];
    const result = await matchTrack(track, YOUTUBE_API_KEY, config, config.matchThreshold, oauth2Auth);
    matchResults.push(result);

    const statusIcon = result.status === "matched" ? "✅" : result.status === "ambiguous" ? "⚠️" : "❌";
    const confidence = result.confidence > 0 ? `(${Math.round(result.confidence * 100)}%)` : "";

    if (options.verbose) {
      console.log(
        `${statusIcon} [${i + 1}/${tracks.length}] ${track.artist ? `${track.artist} - ` : ""}${track.title} ${confidence}`
      );
      if (result.bestMatch) {
        console.log(chalk.gray(`   → ${result.bestMatch.title} (${result.bestMatch.videoId})`));
      }
    } else {
      process.stdout.write(`\r${chalk.gray(`${i + 1}/${tracks.length} tracks processed`)}`);
    }
  }

  console.log("\n");

  const matched = matchResults.filter((r) => r.status === "matched");
  const ambiguous = matchResults.filter((r) => r.status === "ambiguous");
  const unmatched = matchResults.filter((r) => r.status === "unmatched");

  if (ambiguous.length > 0 && options.interactive) {
    console.log(chalk.yellow(`\n${ambiguous.length} ambiguous track(s). Entering interactive mode...\n`));

    for (const result of ambiguous) {
      console.log(chalk.cyan(`\nTrack: ${result.track.artist ? `${result.track.artist} - ` : ""}${result.track.title}`));
      console.log(`Confidence: ${Math.round(result.confidence * 100)}%`);
      console.log("\nSelect a match:");

      const alternatives = result.alternatives.slice(0, 3);
      alternatives.push({ videoId: "", title: "Skip this track", channelTitle: "", thumbnailUrl: "" });

      for (let i = 0; i < alternatives.length; i++) {
        const alt = alternatives[i];
        console.log(`  ${i + 1}. ${alt.title} (${alt.channelTitle})`);
      }

      const readline = await import("readline");
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      const choice = await new Promise<number>((resolve) => {
        rl.question(chalk.gray("\nEnter choice (1-4): "), (answer) => {
          rl.close();
          const num = parseInt(answer, 10);
          resolve(isNaN(num) || num < 1 || num > 4 ? 4 : num - 1);
        });
      });

      const selected = alternatives[choice];
      if (selected.videoId) {
        result.bestMatch = selected;
        result.status = "matched";
        result.confidence = 1.0;
      }
    }
  }

  console.log(chalk.blue(`\n=== Playlist: "${playlistName}" ===\n`));
  console.log(chalk.green(`  ✅ Matched:   ${matched.length} tracks`));
  if (ambiguous.length > 0) {
    console.log(chalk.yellow(`  ⚠️  Ambiguous: ${ambiguous.length} tracks${options.interactive ? " (resolved)" : " (skipped — use --interactive)"}`));
  }
  console.log(chalk.red(`  ❌ Unmatched: ${unmatched.length} tracks`));

  if (matched.length === 0) {
    console.log(chalk.yellow("\nNo matched tracks to add. Exiting.\n"));
    process.exit(0);
  }

  const quotaEstimate = calculateQuotaUsage(tracks.length, matched.length);
  console.log(chalk.gray(`\nEstimated API quota: ${quotaEstimate} units\n`));

  if (!oauth2Auth) {
    console.log(chalk.red("\nOAuth2 authentication required for playlist creation.\n"));
    process.exit(1);
  }

  console.log(chalk.gray("Creating playlist on YouTube Music..."));

  const result = await createPlaylistWithTracks(oauth2Auth as OAuth2Client, playlistName, matchResults, (added, total) => {
    process.stdout.write(`\r${chalk.gray(`Adding tracks: ${added}/${total}`)}`);
  });

  console.log(chalk.green(`\n\n✅ Playlist created successfully!`));
  console.log(chalk.cyan(`   URL: ${result.playlistUrl}`));
  console.log(chalk.gray(`   Added: ${result.matched} tracks`));
  console.log(chalk.gray(`   Quota used: ${result.quotaUsed} units\n`));

  if (result.unmatchedTracks.length > 0) {
    console.log(chalk.yellow(`⚠️  ${result.unmatched} tracks could not be matched:\n`));
    for (const track of result.unmatchedTracks.slice(0, 10)) {
      console.log(chalk.gray(`   - ${track.artist ? `${track.artist} - ` : ""}${track.title}`));
    }
    if (result.unmatchedTracks.length > 10) {
      console.log(chalk.gray(`   ... and ${result.unmatchedTracks.length - 10} more`));
    }
    console.log("");
  }

  if (options.output) {
    const report = {
      playlistName,
      playlistUrl: result.playlistUrl,
      matched: matched.map((r) => ({
        track: r.track,
        videoId: r.bestMatch?.videoId,
        title: r.bestMatch?.title,
        confidence: r.confidence,
      })),
      ambiguous: ambiguous.map((r) => ({
        track: r.track,
        bestMatch: r.bestMatch ? { title: r.bestMatch.title, videoId: r.bestMatch.videoId } : null,
        confidence: r.confidence,
      })),
      unmatched: unmatched.map((r) => ({ track: r.track })),
      summary: {
        total: tracks.length,
        matchedCount: matched.length,
        ambiguousCount: ambiguous.length,
        unmatchedCount: unmatched.length,
      },
    };

    fs.writeFileSync(options.output, JSON.stringify(report, null, 2));
    console.log(chalk.gray(`Report saved to: ${options.output}\n`));
  }
}

async function runDryRun(
  tracks: Track[],
  threshold: number,
  verbose: boolean,
  offline: boolean
): Promise<void> {
  console.log(chalk.yellow("DRY RUN MODE - No playlist will be created\n"));

  if (offline) {
    console.log(chalk.cyan("OFFLINE MODE - Simulating API responses with 0.8 confidence\n"));

    const results: MatchResult[] = [];

    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i];
      const result = simulateOfflineMatch(track);
      results.push(result);

      const statusIcon = "✅";
      const confidence = " 80%";

      console.log(`${statusIcon} ${track.artist ? `${track.artist} - ` : ""}${track.title}${confidence}`);

      if (verbose && result.bestMatch) {
        console.log(chalk.gray(`   → ${result.bestMatch.title} (simulated)`));
        console.log(chalk.gray(`   → ${result.bestMatch.channelTitle}`));
      }
    }

    const matched = results.filter((r) => r.status === "matched");

    console.log(chalk.blue("\n=== Summary ===\n"));
    console.log(chalk.green(`  ✅ Would match:   ${matched.length} (simulated)`));
    console.log(chalk.yellow(`  ⚠️  Ambiguous:     0`));
    console.log(chalk.red(`  ❌ Would skip:   ${tracks.length - matched.length}`));
    console.log(chalk.gray(`\nQuota used: 0 units (offline mode)\n`));
    return;
  }

  if (!YOUTUBE_API_KEY) {
    throw new Error(
      "YOUTUBE_API_KEY environment variable is required for full mode.\n" +
      "Set it with: export YOUTUBE_API_KEY=your_api_key"
    );
  }

  console.log(chalk.green("Using YOUTUBE_API_KEY from environment\n"));

  let oauth2Auth: AuthClient | undefined;
  console.log(chalk.gray("Attempting OAuth2 for playlist creation..."));
  try {
    const tempAuth = await getAuthClient();
    const isValid = await validateAuth(tempAuth);
    if (isValid) {
      oauth2Auth = tempAuth;
      console.log(chalk.green("OAuth2 available for playlist creation.\n"));
    } else {
      console.log(chalk.yellow("OAuth2 not available. Playlist creation will be skipped.\n"));
    }
  } catch {
    console.log(chalk.yellow("OAuth2 authentication skipped. Playlist creation will be skipped.\n"));
  }

  const config = { maxResults: 5, musicCategoryId: "10", matchThreshold: threshold };
  console.log(chalk.gray("Searching and matching tracks...\n"));

  const results: MatchResult[] = [];

  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i];
    const result = await matchTrack(track, YOUTUBE_API_KEY, config, threshold, oauth2Auth);
    results.push(result);

    const statusIcon = result.status === "matched" ? "✅" : result.status === "ambiguous" ? "⚠️" : "❌";
    const confidence = result.confidence > 0 ? ` ${Math.round(result.confidence * 100)}%` : "";

    console.log(`${statusIcon} ${track.artist ? `${track.artist} - ` : ""}${track.title}${confidence}`);

    if (verbose && result.bestMatch) {
      console.log(chalk.gray(`   → ${result.bestMatch.title}`));
      console.log(chalk.gray(`   → ${result.bestMatch.channelTitle}`));
    }
  }

  const matched = results.filter((r) => r.status === "matched");
  const ambiguous = results.filter((r) => r.status === "ambiguous");
  const unmatched = results.filter((r) => r.status === "unmatched");

  console.log(chalk.blue("\n=== Summary ===\n"));
  console.log(chalk.green(`  ✅ Would match:   ${matched.length}`));
  console.log(chalk.yellow(`  ⚠️  Ambiguous:     ${ambiguous.length}`));
  console.log(chalk.red(`  ❌ Would skip:   ${unmatched.length}`));

  const quotaEstimate = calculateQuotaUsage(tracks.length, matched.length);
  console.log(chalk.gray(`\nEstimated API quota: ${quotaEstimate} units`));
  console.log(chalk.gray(`Run without --dry-run to create the playlist\n`));
}

runCli().catch(console.error);
