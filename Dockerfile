# ==============================================================================
# Dockerfile — Next.js MQTT Station (FE + BE API routes)
# Deploy trên Dokploy hoặc bất kỳ host Docker nào.
#
# Build:  docker build -t mqtt-station .
# Run:    docker run -p 3000:3000 --env-file .env mqtt-station
# ==============================================================================

# ------------------------------------------------------------------------------
# Stage 1: deps — cài dependencies (cache riêng, chỉ build lại khi package*.json đổi)
# ------------------------------------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /app

# Copy trước lockfile để tận dụng layer cache
COPY package.json package-lock.json* ./
RUN npm ci

# ------------------------------------------------------------------------------
# Stage 2: builder — build Next.js standalone
# ------------------------------------------------------------------------------
FROM node:22-alpine AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# NEXT_TELEPORT_DISABLED tránh telemetry khi build
ENV NEXT_TELEMETRY_DISABLED=1
# Build dùng biến giả — MQTT_URL thật được inject lúc runtime
ENV MQTT_URL=mqtt://emqx:1883
ENV MQTT_USERNAME=build-placeholder
ENV MQTT_PASSWORD=build-placeholder

RUN npm run build

# ------------------------------------------------------------------------------
# Stage 3: runner — image chạy production (nhỏ, bảo mật)
# ------------------------------------------------------------------------------
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Tạo user non-root để chạy app (không chạy bằng root)
# /app/data: registry thiết bị (devices.json...) — volume app_data mount vào đây,
# PHẢI chown trước (Docker chỉ copy ownership từ image vào volume khi volume trống).
RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 nextjs \
    && mkdir -p /app/uploads /app/data \
    && chown -R nextjs:nodejs /app/uploads /app/data

# Copy output standalone từ builder (bao gồm server.js tối giản)
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs

EXPOSE 3000

# Healthcheck: gọi /api/health nội bộ (xem src/app/api/health/route.ts)
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# .next/standalone sinh sẵn server.js — chỉ cần `node server.js`
CMD ["node", "server.js"]
