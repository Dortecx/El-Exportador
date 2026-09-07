# El Exportador

[English](README.md)

El Exportador convierte listas de reproducción `.m3u` en listas de YouTube Music o Spotify mediante una aplicación web local.

## Funciones

- Sube una lista `.m3u` y crea la lista correspondiente en YouTube Music o Spotify.
- Consulta el progreso, cancela una ejecución y revisa los efectos parciales confirmados sin asumir que una inserción interrumpida no ocurrió.
- Empieza en Modo de prueba para revisar pistas coincidentes, no encontradas y ambiguas sin crear una lista; desactívalo solo cuando quieras crearla.
- Revisa manualmente las pistas no encontradas o ambiguas antes de añadir selecciones a una lista creada sin modo de prueba.

## Requisitos

- Node.js 20 o posterior.
- Se recomienda Python 3.11.8.
- npm (incluido con Node.js).

## Inicio rápido local

```bash
git clone https://github.com/Dortecx/El-Exportador.git
cd el-exportador
pip install -r requirements.txt
npm ci
npm run web
```

Se prefiere `npm ci` porque instala las dependencias fijadas en `package-lock.json`. Abre `http://localhost:3000` cuando se inicie el servidor.

## Uso

1. Sube un archivo `.m3u` en la aplicación local.

   <img src="docs/images/homepage.png" alt="Pantalla de carga de lista" width="720">

2. Inicia la conversión y consulta su progreso.

   <img src="docs/images/converting_process.png" alt="Pantalla de progreso de conversión" width="720">

3. Resuelve las pistas no encontradas o ambiguas cuando se solicite.

   <img src="docs/images/manual_revision.png" alt="Pantalla de revisión manual de pistas" width="720">

4. Busca la lista creada en el destino seleccionado.

   <img src="docs/images/Resume.png" alt="Resumen del resultado de la conversión" width="720">

## Aplicación portátil para Windows

Crea el ZIP portátil para Windows desde Windows:

```powershell
npm run build:portable:win
```

Para crear el ZIP portátil se requiere Windows, Node.js 20 o posterior y Python 3.11.8 con PyInstaller. Para ejecutar el ZIP se requiere Node.js 20 o posterior.

### Configuración de Spotify para mantenimiento

Las compilaciones portátiles con Spotify necesitan una única aplicación de Spotify Developer administrada por mantenimiento:

1. Registra una aplicación de Spotify Developer y configúrala con **Authorization Code + PKCE**.
2. Registra esta URI exacta de devolución de llamada local: `http://127.0.0.1:3000/api/spotify-auth/callback`.
3. Durante la compilación, proporciona el Client ID público de la aplicación mediante el parámetro de PowerShell `-SpotifyClientId` o la variable de entorno `SPOTIFY_CLIENT_ID`. La compilación se detiene claramente si no se proporciona ninguno.
4. Nunca uses ni confirmes en el repositorio un client secret, token, código de autorización ni otro valor de autorización de Spotify. El Client ID público es el único valor de Spotify incluido en el iniciador portátil.

Las personas usuarias no configuran credenciales de Spotify: solo hacen clic en **Conectar Spotify** dentro de la aplicación local y autorizan directamente con OAuth de Spotify mediante PKCE. Spotify crea listas privadas. YouTube Music usa el inicio de sesión guiado del navegador y su autenticación específica; la privacidad de sus listas sigue el comportamiento de la cuenta/API de YouTube Music.

## Compatibilidad de plataforma

El Exportador solo es compatible con Windows.

## Licencia

Este proyecto se distribuye bajo la licencia MIT.
