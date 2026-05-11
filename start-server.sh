#!/bin/bash

# Matar procesos anteriores en el puerto 3000
kill -9 $(lsof -i :3000 | grep LISTEN | awk '{print $2}') 2>/dev/null || echo "No hay proceso en el puerto 3000"

# Correr el servidor en segundo plano con nohup
nohup npm run web > server.log 2>&1 &

# Mostrar PID del proceso
echo "✅ Servidor corriendo en segundo plano con PID: $!"
echo "📝 Logs en: server.log"
echo "🌐 Accede a: http://localhost:3000"