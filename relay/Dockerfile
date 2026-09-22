# Relay production container.
# Build:  docker build -t relay .
# Run:    docker run -p 3000:3000 --env-file .env relay
#         (point MONGODB_URI at Atlas or a mongo container)

FROM node:22-alpine AS base
WORKDIR /app
ENV NODE_ENV=production

# --- Dependencies ------------------------------------------------------
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# --- Build (needs devDependencies) -------------------------------------
FROM base AS build
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.node.json vite.config.ts postcss.config.js index.html ./
COPY src ./src
COPY server ./server
RUN npm run build

# --- Runtime ------------------------------------------------------------
FROM base AS runtime
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY server ./server
COPY package.json ./
# Non-root user
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npx", "tsx", "server/index.ts"]
