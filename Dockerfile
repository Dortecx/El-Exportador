# Usar Python 3.11.8
FROM python:3.11.8-slim

# Instalar Node.js y npm
RUN apt-get update && apt-get install -y curl && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs

# Copiar el proyecto
WORKDIR /app
COPY . .

# Instalar dependencias
RUN pip install -r requirements.txt && \
    npm install

# Exponer el puerto 3000
EXPOSE 3000

# Comando para correr el servidor
CMD ["npm", "run", "web"]