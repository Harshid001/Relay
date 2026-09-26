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
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend ./
RUN npm run build

# --- Backend Build (compiled JS, no tsx in production) -----------------
FROM base AS backend-build
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json backend/tsconfig.json backend/tsconfig.build.json ./
RUN npm ci
COPY backend/server ./server
RUN npx tsc -p tsconfig.build.json

# --- Runtime ------------------------------------------------------------
FROM base AS runtime
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev
COPY --from=backend-build /app/backend/dist ./dist
COPY --from=frontend-build /app/frontend/dist /app/frontend/dist
# Non-root user
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server/index.js"]
