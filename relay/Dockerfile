# Relay production container.
# Build:  docker build -t relay .
# Run:    docker run -p 3000:3000 --env-file backend/.env relay
#         (point MONGODB_URI at Atlas or a mongo container)

FROM node:22-alpine AS base
WORKDIR /app
ENV NODE_ENV=production

# --- Frontend Build ----------------------------------------------------
FROM node:22-alpine AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json ./
RUN npm install
COPY frontend ./
RUN npm run build

# --- Backend Dependencies ----------------------------------------------
FROM base AS backend-deps
WORKDIR /app/backend
COPY backend/package.json ./
RUN npm install --omit=dev

# --- Runtime ------------------------------------------------------------
FROM base AS runtime
WORKDIR /app/backend
COPY --from=backend-deps /app/backend/node_modules ./node_modules
COPY --from=frontend-build /app/frontend/dist /app/frontend/dist
COPY backend ./
# Non-root user
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npx", "tsx", "server/index.ts"]
