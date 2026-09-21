FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# Las dependencias se instalan antes de copiar el código: mientras el lock no
# cambie, reconstruir tras editar el código reutiliza esta capa.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

USER node
EXPOSE 3000

# Usa /healthz, que no llama a ninguna API externa: así una caída de Polymarket
# no marca el contenedor como enfermo.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
