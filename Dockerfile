# Stage 1: build the player and admin apps (frontend/) into public/app.
FROM node:20-alpine AS ui
WORKDIR /build
COPY frontend/package*.json ./frontend/
RUN cd frontend && npm ci
COPY frontend ./frontend
RUN cd frontend && npm run build

# Stage 2: the server.
FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public
COPY --from=ui /build/public/app ./public/app
COPY scripts ./scripts
# config/, papers/ and media/ are mounted at run time (docker-compose.prod.yml), never baked into the image:
# config/game.json holds the secret price script.
RUN mkdir -p config papers media && chown node:node config papers media
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "src/server.js"]
