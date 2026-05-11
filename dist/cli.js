#!/usr/bin/env node
"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runCli = runCli;
exports.run = run;
const commander_1 = require("commander");
const chalk_1 = __importDefault(require("chalk"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const parser_1 = require("./parser");
const client_1 = require("./ytmusic/client");
const VERSION = "1.0.0";
async function runCli() {
    const program = new commander_1.Command();
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
        console.error(chalk_1.default.red("Error: No file specified"));
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
        console.error(chalk_1.default.red(`Error: ${error.message}`));
        process.exit(1);
    }
}
async function run(filePath, options) {
    console.log(chalk_1.default.blue("\n=== M3U to YouTube Music ===\n"));
    if (!(0, client_1.checkYtMusicAvailable)()) {
        throw new Error("ytmusicapi is not configured. Expected auth file at ~/.config/m3u-to-ytmusic/ytmusic_auth.json");
    }
    console.log(chalk_1.default.gray("Parsing M3U file..."));
    const { tracks, format } = (0, parser_1.parseFile)(filePath);
    console.log(chalk_1.default.gray(`Found ${tracks.length} tracks (${format} format)\n`));
    const playlistName = options.name ?? path.basename(filePath, path.extname(filePath));
    if (options.dryRun) {
        console.log(chalk_1.default.yellow("DRY RUN MODE - No playlist will be created\n"));
    }
    console.log(chalk_1.default.gray(`Using ytmusicapi backend (${options.dryRun ? "search only" : "search + create playlist"})...`));
    const result = await (0, client_1.convertWithYtMusic)(tracks, playlistName, { dryRun: options.dryRun ?? false });
    printResults(tracks, result, options.verbose ?? false);
    if (!options.dryRun && result.playlistUrl) {
        console.log(chalk_1.default.green(`\n✅ Playlist created successfully!`));
        console.log(chalk_1.default.cyan(`   URL: ${result.playlistUrl}`));
        console.log(chalk_1.default.gray(`   Added: ${result.matched} tracks\n`));
    }
    else if (!options.dryRun) {
        console.log(chalk_1.default.yellow("\nNo playlist was created. Check unmatched tracks and backend logs.\n"));
    }
    else {
        console.log(chalk_1.default.gray("\nDry run completed. Run without --dry-run to create the playlist.\n"));
    }
    if (options.output) {
        fs.writeFileSync(options.output, JSON.stringify(result, null, 2));
        console.log(chalk_1.default.gray(`Report saved to: ${options.output}\n`));
    }
}
function printResults(tracks, result, verbose) {
    for (let i = 0; i < result.results.length; i++) {
        const item = result.results[i];
        const statusIcon = item.status === "matched" ? "✅" : item.status === "ambiguous" ? "⚠️" : "❌";
        console.log(`${statusIcon} [${i + 1}/${tracks.length}] ${item.artist ? `${item.artist} - ` : ""}${item.title}`);
        if (verbose && item.bestMatch) {
            console.log(chalk_1.default.gray(`   → ${item.bestMatch.title} (${item.bestMatch.videoId})`));
            console.log(chalk_1.default.gray(`   → ${item.bestMatch.artist}`));
        }
    }
    const matched = result.results.filter((entry) => entry.status === "matched").length;
    const ambiguous = result.results.filter((entry) => entry.status === "ambiguous").length;
    const unmatched = result.results.filter((entry) => entry.status === "unmatched").length;
    console.log(chalk_1.default.blue("\n=== Summary ===\n"));
    console.log(chalk_1.default.green(`  ✅ Matched:   ${matched}`));
    console.log(chalk_1.default.yellow(`  ⚠️  Ambiguous: ${ambiguous}`));
    console.log(chalk_1.default.red(`  ❌ Unmatched: ${unmatched}`));
}
runCli().catch(console.error);
//# sourceMappingURL=cli.js.map