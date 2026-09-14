# Multi-stage, because the image that runs in production should not carry the
# toolchain that built it. The runtime stage has no TypeScript compiler, no test
# framework and no dev dependencies — less to patch, less to exploit, and a smaller
# image to pull on every deploy.

# ---- build ----------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

# Dependencies first, so a change to src/ does not re-resolve the whole tree. The
# lockfile is copied with package.json and `npm ci` is used rather than `npm install`:
# ci installs exactly what the lockfile says and fails if the two disagree, which is
# the difference between a reproducible build and one that resolves whatever was
# newest that morning.
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund

COPY tsconfig*.json ./
COPY src ./src
RUN npm run build

# ---- runtime --------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Production dependencies only. `npm ci --omit=dev` against the same lockfile, so the
# runtime tree is a strict subset of what the build resolved rather than a second,
# independent resolution.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=build /app/dist ./dist

# Not root. A container that does not need to write to its own filesystem should not be
# able to, and node:alpine ships a `node` user for exactly this.
USER node

EXPOSE 8080
CMD ["node", "dist/main.js"]
