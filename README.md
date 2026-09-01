# El Exportador - M3U to YouTube Music Playlist Converter

[License: MIT](https://opensource.org/licenses/MIT)

--- | [English](#english) | [Español](#español) |
--- | --- | --- |

# English

## Description
**El Exportador** is a tool designed to simplify the process of migrating your playlists from `.m3u` format to YouTube Music. Whether you're switching music platforms or just want to sync your existing playlists, this tool automates the conversion and upload process.

### Features
- **Easy Conversion**: Upload your `.m3u` file and convert it into a YouTube Music playlist.
- **Authentication Support**: Securely log in to your YouTube Music account to manage playlists.
- **Real-Time Progress**: Track the conversion progress with a real-time progress bar.
- **Multi-Platform**: Works on Windows, macOS, and Linux.

---

## Installation

### Prerequisites
- **Python 3.11.8** (recommended).
- **Node.js** (v18 or higher).
- **npm** (comes with Node.js).

### Steps
1. Clone the repository:
   ```bash
   git clone https://github.com/your-username/el-exportador.git
   cd el-exportador
   ```

2. Install Python dependencies:
   ```bash
   pip install -r requirements.txt
   ```

3. Install Node.js dependencies:
   ```bash
   npm install
   ```

4. Run the server:
   ```bash
   npm run web
   ```

5. Open your browser and navigate to:
   ```bash
   http://localhost:3000
   ```

---

## Usage
1. **Authenticate**: Click the "Authenticate with YouTube Music" button to log in to your account.
2. **Upload**: Select and upload your `.m3u` playlist file.
3. **Convert**: Wait for the conversion to complete. The progress bar will update in real-time.
4. **Enjoy**: Your playlist will be available in YouTube Music!

---

## Portable Windows ZIP

On Windows, create a self-contained application ZIP with:

```powershell
npm run build:portable:win
```

The build creates `portable-win/El-Exportador-<version>-windows.zip`. It requires Node.js 20+, the project Python requirements, and PyInstaller; it stops with an actionable message if PyInstaller is unavailable. The build installs the lockfile's production Node dependencies into the staged package, freezes `src/ytmusic/searcher.py` as `artifacts/searcher.exe`, and includes only the runtime TypeScript modules and `public` assets. It never reuses `dist`.

Extract the ZIP and run `start.cmd`. The launcher verifies Node.js 20+ and checks `artifacts/searcher.exe`. It writes only its own state (including the browser profile) to `state/` and server output to `logs/server.log`, beside `start.cmd`. It reads the genuine `%LOCALAPPDATA%` only to discover a supported Chromium browser (Helium, Chrome, Brave, Opera, or Edge) required for guided YouTube Music authentication.

The portable runtime deliberately uses the existing `tsx src/web/server.ts` execution model, shipped as a production dependency. Under the current source-only server and TypeScript configuration, a standalone compiled `node app/...` server cannot be produced without changing files outside this portable-build edit surface; `dist/web/server.js` is not used.

## License
This project is licensed under the **MIT License**. See the [LICENSE](LICENSE) file for details.

---

# Español

## Descripción
**El Exportador** es una herramienta diseñada para simplificar el proceso de migrar tus listas de reproducción en formato `.m3u` a YouTube Music. Ya sea que estés cambiando de plataforma de música o simplemente quieras sincronizar tus listas existentes, esta herramienta automatiza la conversión y el proceso de subida.

### Características
- **Conversión sencilla**: Sube tu archivo `.m3u` y conviértelo en una lista de reproducción de YouTube Music.
- **Soporte de autenticación**: Inicia sesión de forma segura en tu cuenta de YouTube Music para gestionar tus listas.
- **Progreso en tiempo real**: Realiza un seguimiento del progreso de la conversión con una barra de progreso en tiempo real.
- **Multiplataforma**: Funciona en Windows, macOS y Linux.

---

## Instalación

### Requisitos previos
- **Python 3.11.8** (recomendado).
- **Node.js** (v18 o superior).
- **npm** (viene incluido con Node.js).

### Pasos
1. Clona el repositorio:
   ```bash
   git clone https://github.com/tu-usuario/el-exportador.git
   cd el-exportador
   ```

2. Instala las dependencias de Python:
   ```bash
   pip install -r requirements.txt
   ```

3. Instala las dependencias de Node.js:
   ```bash
   npm install
   ```

4. Ejecuta el servidor:
   ```bash
   npm run web
   ```

5. Abre tu navegador y navega a:
   ```bash
   http://localhost:3000
   ```

---

## Uso
1. **Autenticación**: Haz clic en el botón "Autenticar con YouTube Music" para iniciar sesión en tu cuenta.
2. **Subir**: Selecciona y sube tu archivo `.m3u`.
3. **Convertir**: Espera a que se complete la conversión. La barra de progreso se actualizará en tiempo real.
4. **Disfruta**: ¡Tu lista de reproducción estará disponible en YouTube Music!

---

## ZIP portátil para Windows

En Windows, crea un ZIP autocontenido con:

```powershell
npm run build:portable:win
```

El ZIP se crea en `portable-win/El-Exportador-<version>-windows.zip`. Requiere Node.js 20+, los requisitos de Python del proyecto y PyInstaller. Si PyInstaller no está disponible, el script se detiene con una instrucción concreta. El paquete congela el buscador como `artifacts/searcher.exe`, incluye las dependencias Node de producción, los módulos TypeScript necesarios y los recursos de `public`; no reutiliza `dist`.

Extrae el ZIP y ejecuta `start.cmd`. El lanzador comprueba Node.js 20+ y el ejecutable congelado. Escribe únicamente su propio estado (incluido el perfil del navegador) en `state/` y los registros en `logs/server.log`, junto a `start.cmd`. Lee el `%LOCALAPPDATA%` genuino solo para detectar un navegador Chromium compatible (Helium, Chrome, Brave, Opera o Edge), necesario para la autenticación guiada.

El runtime portátil usa deliberadamente el modelo existente `tsx src/web/server.ts`, distribuido como dependencia de producción. Con el servidor y la configuración TypeScript actuales no es posible entregar un servidor compilado independiente mediante `node app/...` sin modificar archivos fuera de esta superficie de edición; no se usa `dist/web/server.js`.

## Licencia
Este proyecto está licenciado bajo la **Licencia MIT**. Consulta el archivo [LICENSE](LICENSE) para más detalles.