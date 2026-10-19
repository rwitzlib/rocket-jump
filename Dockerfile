# Rocket Jump game server: serves the client and runs matches on one port.
#   docker build -t rocket-jump .
#   docker run -p 8080:8080 rocket-jump
# Configure with environment variables (see src/server/main.ts), e.g. -e MAPS=citadel -e MIN_PLAYERS=6

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:8080/health || exit 1
CMD ["node", "dist-server/main.js"]
