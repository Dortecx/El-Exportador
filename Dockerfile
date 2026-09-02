FROM node:20-slim AS node

FROM python:3.11.8-slim

RUN apt-get update && apt-get install -y --no-install-recommends libstdc++6 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=node /usr/local /usr/local

WORKDIR /app

COPY requirements.txt package.json package-lock.json ./
RUN pip install --no-cache-dir -r requirements.txt && npm ci

COPY . .

ENV PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || '3000') + '/').then(response => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1))"

CMD ["npm", "run", "web"]
