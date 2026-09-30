# ShipRate — platform Dockerfile.
# Build layout assumption: server.js lives at backend/server.js and
# references ../.env (platform/.env) and ../frontend (platform/frontend)
# via path.join(__dirname, '..', ...). COPY . keeps those relative paths.

FROM node:20-slim

WORKDIR /app

# Install backend dependencies first (layer-cached on package.json changes).
COPY backend/package*.json ./backend/
RUN npm install --prefix backend

# Copy the rest of the platform tree (backend, frontend, db, config).
COPY . .

EXPOSE 5000

CMD ["node", "backend/server.js"]
