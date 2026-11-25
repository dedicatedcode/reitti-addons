FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY assets ./assets
COPY ATTRIBUTION.md ./ATTRIBUTION.md
COPY .env.germany.example ./.env
COPY regions.json ./regions.json

# The unprivileged node user must own the cache directory. Creating it in the
# image also makes Docker initialize new named volumes with node ownership.
RUN mkdir -p /app/data/gtfs-static && chown -R node:node /app/data

USER node
EXPOSE 8090

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node --env-file=.env -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8090) + '/health').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"

CMD ["node", "--env-file=.env", "src/server.js"]
