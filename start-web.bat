@echo off
cd "C:\Users\Dom\Documents\Projects\El Exportador\m3u-to-ytmusic"
start /b node node_modules\tsx\dist\cli.mjs src\web\server.ts
timeout /t 5 /nobreak >nul