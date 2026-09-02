# El Exportador

[Español](Readme.es.md)

El Exportador converts `.m3u` playlists into YouTube Music playlists through a local web application.

## Features

- Upload an `.m3u` playlist and create a matching YouTube Music playlist.
- Follow conversion progress in the browser.
- Use guided browser authentication on supported Windows setups.

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

## Use and authentication

1. In the local application, authenticate with YouTube Music when prompted, then upload an `.m3u` file.

   <img src="docs/images/homepage.png" alt="Authentication and playlist upload screen" width="720">

2. Start the conversion and follow its progress.

   <img src="docs/images/converting_process.png" alt="Conversion progress screen" width="720">

3. Resolve any unmatched or ambiguous tracks when prompted.

   <img src="docs/images/manual_revision.png" alt="Manual track review screen" width="720">

4. Find the created playlist in YouTube Music.

   <img src="docs/images/Resume.png" alt="Conversion result summary" width="720">

Guided browser authentication is available only on Windows. Do not expect it to work on macOS, Linux, or WSL.

## Windows portable application

Build the Windows portable ZIP on Windows:

```powershell
npm run build:portable:win
```

Building the portable ZIP requires Node.js 20 or later, Python 3.11.8 with PyInstaller, and Windows. Running the ZIP requires Node.js 20 or later and a supported Chromium browser for guided authentication. WSL cannot use guided authentication or build the Windows portable application.

## Platform limitations

The local server can be run where its dependencies are supported, but guided browser authentication is Windows-only. Non-Windows platforms and WSL do not have a guided-login alternative in this project.

## License

This project is licensed under the MIT License.
