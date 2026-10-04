# minitok entitlement server — production image.
#
# Build:  docker build -t minitok-entitlement ./server
# Run:    docker run -p 3000:3000 -e MINITOK_JWT_SECRET=<secret> minitok-entitlement
#
# The image runs as a non-root user. All runtime config is via env vars:
#   PORT               (default 3000)
#   MINITOK_JWT_SECRET (required in production — no secure default exists)

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY index.js ./
COPY middleware ./middleware
COPY models ./models
COPY routes ./routes
COPY public ./public

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "index.js"]
