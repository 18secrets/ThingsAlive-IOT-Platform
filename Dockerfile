# Multi-stage, because the image that runs in production should not carry the
# toolchain that built it. The runtime stage has no TypeScript compiler, no test
# framework and no dev dependencies — less to patch, less to exploit, and a smaller
# image to pull on every deploy.

# glibc (Debian bookworm), not Alpine, since QML1 (D46): the scheduler image must carry
# Python 3.11 for the forecaster, and Alpine now ships Python 3.14, which granite-tsfm
# does not support (QML1-SIZE). The api moves too, so both services share one base to
# patch; it costs the api +19 MB compressed and nothing else (QML1-SIZE variant C/E).
# The api never carries Python or torch: those are only in Dockerfile.scheduler.

# ---- build ----------------------------------------------------------------
FROM node:22-bookworm-slim AS build
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
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Production dependencies only. `npm ci --omit=dev` against the same lockfile, so the
# runtime tree is a strict subset of what the build resolved rather than a second,
# independent resolution.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=build /app/dist ./dist

# Not root. A container that does not need to write to its own filesystem should not be
# able to, and the node image ships a `node` user for exactly this.
USER node

EXPOSE 8080
CMD ["node", "dist/main.js"]
