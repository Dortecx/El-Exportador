#!/usr/bin/env node
import { Command } from "commander";
import chalk from "chalk";
import * as fs from "fs";
import * as path from "path";
import { parseFile } from "./parser.js";
import { convertWithYtMusic, checkYtMusicAvailable } from "./ytmusic/client.js";
const VERSION = "1.0.0";
export async function runCli() {
    const program = new Command();
    program
        .name("m3u-to-ytmusic")
        .description("Convert M3U playlists to YouTube Music")
        .version(VERSION)
        .argument("<file>", "Path to M3U or M3U8 file")
        .option("-n, --name <name>", "Playlist name on YouTube Music (default: filename)")
        .option("--threshold <0-1>", "Reserved for future tuning", (val) => parseFloat(val), 0.6)
        .option("-o, --output <file>", "Output JSON report to file")
        .option("-v, --verbose", "Show per-track search details")
        .option("--dry-run", "Show matches without creating playlist")
        .addHelpText("after", `
Requirements:
  - Python available in PATH or project .venv
  - ytmusicapi installed
  - ~/.config/m3u-to-ytmusic/ytmusic_auth.json configured

Examples:
  # Dry-run without creating a playlist
  m3u-to-ytmusic playlist.m3u --dry-run

  # Create the playlist in YouTube Music
  m3u-to-ytmusic playlist.m3u --name "My Playlist"
`);
    program.parse();
    const opts = program.opts();
    const filePath = program.args[0];
    if (!filePath) {
        console.error(chalk.red("Error: No file specified"));
        console.log("Usage: m3u-to-ytmusic <file.m3u> [options]");
        process.exit(1);
    }
    try {
        await run(filePath, {
            name: opts.name,
            dryRun: opts.dryRun,
            threshold: opts.threshold,
            output: opts.output,
            verbose: opts.verbose,
            file: filePath,
        });
    }
    catch (error) {
        console.error(chalk.red(`Error: ${error.message}`));
        process.exit(1);
    }
}
export async function run(filePath, options) {
    console.log(chalk.blue("\n=== M3U to YouTube Music ===\n"));
    if (!checkYtMusicAvailable()) {
        throw new Error("ytmusicapi is not configured. Expected auth file at ~/.config/m3u-to-ytmusic/ytmusic_auth.json");
    }
    console.log(chalk.gray("Parsing M3U file..."));
    const { tracks, format } = parseFile(filePath);
    console.log(chalk.gray(`Found ${tracks.length} tracks (${format} format)\n`));
    const playlistName = options.name ?? path.basename(filePath, path.extname(filePath));
    if (options.dryRun) {
        console.log(chalk.yellow("DRY RUN MODE - No playlist will be created\n"));
    }
    console.log(chalk.gray(`Using ytmusicapi backend (${options.dryRun ? "search only" : "search + create playlist"})...`));
    const result = await convertWithYtMusic(tracks, playlistName, { dryRun: options.dryRun ?? false });
    printResults(tracks, result, options.verbose ?? false);
    if (!options.dryRun && result.playlistUrl) {
        console.log(chalk.green(`\n✅ Playlist created successfully!`));
        console.log(chalk.cyan(`   URL: ${result.playlistUrl}`));
        console.log(chalk.gray(`   Added: ${result.matched} tracks\n`));
    }
    else if (!options.dryRun) {
        console.log(chalk.yellow("\nNo playlist was created. Check unmatched tracks and backend logs.\n"));
    }
    else {
        console.log(chalk.gray("\nDry run completed. Run without --dry-run to create the playlist.\n"));
    }
    if (options.output) {
        fs.writeFileSync(options.output, JSON.stringify(result, null, 2));
        console.log(chalk.gray(`Report saved to: ${options.output}\n`));
    }
}
function printResults(tracks, result, verbose) {
    for (let i = 0; i < result.results.length; i++) {
        const item = result.results[i];
        const statusIcon = item.status === "matched" ? "✅" : item.status === "ambiguous" ? "⚠️" : "❌";
        console.log(`${statusIcon} [${i + 1}/${tracks.length}] ${item.artist ? `${item.artist} - ` : ""}${item.title}`);
        if (verbose && item.bestMatch) {
            console.log(chalk.gray(`   → ${item.bestMatch.title} (${item.bestMatch.videoId})`));
            console.log(chalk.gray(`   → ${item.bestMatch.artist}`));
        }
    }
    const matched = result.results.filter((entry) => entry.status === "matched").length;
    const ambiguous = result.results.filter((entry) => entry.status === "ambiguous").length;
    const unmatched = result.results.filter((entry) => entry.status === "unmatched").length;
    console.log(chalk.blue("\n=== Summary ===\n"));
    console.log(chalk.green(`  ✅ Matched:   ${matched}`));
    console.log(chalk.yellow(`  ⚠️  Ambiguous: ${ambiguous}`));
    console.log(chalk.red(`  ❌ Unmatched: ${unmatched}`));
}
runCli().catch(console.error);
//# sourceMappingURL=cli.js.map