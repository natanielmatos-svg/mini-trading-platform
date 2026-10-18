FROM node:22-bookworm-slim AS base

ENV NODE_ENV=production
ENV HOST=0.0.0.0
WORKDIR /app

# Las dependencias se instalan antes de copiar el código: mientras el lock no
# cambie, reconstruir tras editar el código reutiliza esta capa.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p /app/data/models /app/datos && chown -R node:node /app/data /app/datos

USER node
EXPOSE 3000

# Usa /healthz, que no llama a ninguna API externa: así una caída de Polymarket
# no marca el contenedor como enfermo.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]

# El objetivo base permite desplegar solo los escenarios estadísticos.
# El objetivo neural incluye el proceso local de TimesFM, sin copiar pesos
# ni credenciales del equipo de desarrollo dentro de la imagen.
FROM base AS neural
USER root
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/forecast-venv \
    && /opt/forecast-venv/bin/pip install --no-cache-dir -r /app/forecast/requirements.txt
ENV FORECAST_PYTHON=/opt/forecast-venv/bin/python
USER node
