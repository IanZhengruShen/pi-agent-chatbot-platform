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

# Stage 2: Production image (Debian-slim for LibreOffice compatibility)
FROM node:20-slim

ARG http_proxy
ARG https_proxy
ARG no_proxy

WORKDIR /app

# Install tsx globally for running TypeScript server
RUN npm install -g tsx

# Install system dependencies:
# - python3/pip/venv: for agent-created python scripts (python-pptx, reportlab)
# - libreoffice-impress: headless PPTX → PDF conversion
# - poppler-utils: PDF → PNG slide images (pdftoppm)
# - fonts-noto/fonts-dejavu: font coverage for rendering
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv \
    libreoffice-impress \
    poppler-utils \
    fonts-noto-core fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

# Install uv (Python package manager for agent scripts)
RUN pip install --break-system-packages uv

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
