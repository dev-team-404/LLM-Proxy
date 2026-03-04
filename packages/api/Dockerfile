# Build stage
FROM node:24-alpine AS builder

RUN echo "http://dl-cdn.alpinelinux.org/alpine/v3.18/main" > /etc/apk/repositories && \
    echo "http://dl-cdn.alpinelinux.org/alpine/v3.18/community" >> /etc/apk/repositories && \
    apk add --no-cache --allow-untrusted openssl1.1-compat

WORKDIR /app

ENV NODE_TLS_REJECT_UNAUTHORIZED=0
RUN npm config set strict-ssl false

COPY package*.json ./
COPY prisma ./prisma/

RUN npm install --include=dev

RUN npx prisma generate

COPY . .

RUN npx tsc

# Production stage
FROM node:24-alpine AS production

RUN echo "http://dl-cdn.alpinelinux.org/alpine/v3.18/main" > /etc/apk/repositories && \
    echo "http://dl-cdn.alpinelinux.org/alpine/v3.18/community" >> /etc/apk/repositories && \
    apk add --no-cache --allow-untrusted openssl1.1-compat

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/dist ./dist
COPY package*.json ./
COPY image.png ./

RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Create image storage directory with correct permissions
RUN mkdir -p /app/generated-images && chown nodejs:nodejs /app/generated-images

USER nodejs

EXPOSE 3000 3001

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

CMD ["sh", "-c", "npx prisma db push --skip-generate && node dist/index.js"]
