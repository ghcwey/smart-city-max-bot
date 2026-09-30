# undici 8 требует Node 22
FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json .npmrc ./
# без --omit=dev: tsx и esbuild нужны и при сборке, и в рантайме
RUN npm ci --no-audit --no-fund && npm cache clean --force

COPY . .
RUN npm run build:app && mkdir -p data && chown -R node:node data

ENV NODE_ENV=production \
    PORT=3000

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node_modules/.bin/tsx", "src/server.ts"]
