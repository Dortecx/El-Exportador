# El Exportador

[Español](README.es.md)

El Exportador converts `.m3u` playlists into YouTube Music or Spotify playlists through a local web application.

## Features

- Upload an `.m3u` playlist and create a matching YouTube Music or Spotify playlist.
- Follow progress, cancel a run, and see confirmed partial effects without assuming an interrupted insertion failed.
- Start in Dry Run Mode to review matched, unmatched, and ambiguous tracks without creating a playlist; turn it off only when ready to create one.
- Review unmatched or ambiguous tracks manually before adding selected tracks to a non-dry-run playlist.

## Requirements

- Node.js 20 or later.
- Python 3.11.8 is recommended.
- npm (included with Node.js).

## Local quick start

```bash
git clone https://github.com/Dortecx/El-Exportador.git
cd el-exportador
pip install -r requirements.txt
npm ci
npm run web
```

`npm ci` is preferred because it installs the dependencies locked in `package-lock.json`. Open `http://localhost:3000` after the server starts.

## Usage

1. Upload an `.m3u` file in the local application.

   <img src="docs/images/homepage.png" alt="Playlist upload screen" width="720">

2. Start the conversion and follow its progress.

   <img src="docs/images/converting_process.png" alt="Conversion progress screen" width="720">

3. Resolve any unmatched or ambiguous tracks when prompted.

   <img src="docs/images/manual_revision.png" alt="Manual track review screen" width="720">

4. Find the created playlist in the selected destination.

   <img src="docs/images/Resume.png" alt="Conversion result summary" width="720">

## Windows portable application

Build the Windows portable ZIP on Windows:

```powershell
npm run build:portable:win
```

Building the portable ZIP requires Node.js 20 or later, Python 3.11.8 with PyInstaller, and Windows. Running the ZIP requires Node.js 20 or later.

### Spotify maintainer setup

Spotify-enabled portable builds need one maintainer-managed Spotify Developer app:

1. Register one Spotify Developer app and configure it for **Authorization Code + PKCE**.
2. Register this exact loopback callback URI: `http://127.0.0.1:3000/api/spotify-auth/callback`.
3. At build time, provide the app's public Client ID with the `-SpotifyClientId` PowerShell parameter or the `SPOTIFY_CLIENT_ID` environment variable. The build stops clearly when neither is provided.
4. Never use or commit a Spotify client secret, token, authorization code, or other authorization value. This public Client ID is the only Spotify value included in the portable launcher.

End users do not configure Spotify credentials: they only click **Connect Spotify** in the local application and authorize directly with Spotify OAuth using PKCE. Spotify creates private playlists. YouTube Music uses the guided browser sign-in and its destination-specific authentication; its playlist privacy follows the YouTube Music account/API behavior.

## Platform support

El Exportador is supported on Windows only.

## License

This project is licensed under the MIT License.
