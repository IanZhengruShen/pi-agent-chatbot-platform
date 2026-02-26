# Stage 1: Install dependencies and build frontend
FROM node:20-alpine AS builder

ARG http_proxy
ARG https_proxy
ARG no_proxy

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Stage 2: Production image
FROM node:20-alpine

ARG http_proxy
ARG https_proxy
ARG no_proxy

WORKDIR /app

# Install tsx globally for running TypeScript server
RUN npm install -g tsx

# Install Python and uv (for agent-created python scripts, e.g. python-pptx, reportlab)
RUN apk add --no-cache python3 py3-pip && \
    pip install --break-system-packages uv

COPY package*.json ./
RUN npm ci --omit=dev

# Copy built frontend
COPY --from=builder /app/dist ./dist

# Copy server and shared source (tsx runs TS directly)
COPY server/ ./server/
COPY src/shared/ ./src/shared/
COPY src/node-stub/ ./src/node-stub/
COPY tsconfig.json ./
COPY vite.config.ts ./

ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

CMD ["tsx", "server/index.ts"]
