# El Exportador

[Español](README.es.md)

El Exportador converts `.m3u` playlists into YouTube Music playlists through a local web application.

## Features

- Upload an `.m3u` playlist and create a matching YouTube Music playlist.
- Start in Dry Run Mode to review matched, unmatched, and ambiguous tracks without creating a playlist; turn it off only when ready to create one.
- Review unmatched or ambiguous tracks manually before adding selected tracks to a non-dry-run playlist.

> Spotify is temporarily unavailable in this release. The public app flow only shows YouTube Music as the destination.

## Requirements

- Node.js 20 or later.
- Python 3.11.8 is recommended.
- npm (included with Node.js).

## Local quick start

```bash
git clone https://github.com/Dortecx/El-Exportador.git
cd el-exportador
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
npm ci
npm run web
```

`npm ci` is preferred because it installs the dependencies locked in `package-lock.json`. After `.venv` is created and requirements are installed, `npm run web` automatically uses the project virtualenv. Set `M3U_YTMUSIC_PYTHON` only when you need a custom interpreter path. Open `http://localhost:3000` after the server starts.

## Usage

1. Upload an `.m3u` file in the local application.

   <img src="docs/images/homepage.png" alt="Playlist upload screen" width="720">

2. Start the conversion and follow its progress.

   <img src="docs/images/converting_process.png" alt="Conversion progress screen" width="720">

3. Resolve any unmatched or ambiguous tracks when prompted.

   <img src="docs/images/manual_revision.png" alt="Manual track review screen" width="720">

4. Find the created playlist in YouTube Music.

   <img src="docs/images/Resume.png" alt="Conversion result summary" width="720">

## Windows portable application

Build the Windows portable ZIP on Windows:

```powershell
npm run build:portable:win
```

Building the portable ZIP requires Node.js 20 or later, Python 3.11.8 with PyInstaller, and Windows. Running the ZIP requires Node.js 20 or later.

YouTube Music uses guided browser sign-in and destination-specific authentication; playlist privacy follows the YouTube Music account/API behavior.

## Platform support

El Exportador is supported on Windows. Native WSL/Linux use is experimental and requires Python 3 plus an installed Chromium-compatible Linux browser (`google-chrome`, `chromium`, Brave, or Microsoft Edge) available on the Linux PATH for guided YouTube Music sign-in. WSL-to-Windows browser `.exe` interop is not supported in this stage.

## License

This project is licensed under the MIT License.
