# QML1-SIZE variant B: the current image (A) plus python3 and CPU torch, on Alpine.
#
# The question is whether torch installs on musl at all. PyTorch publishes manylinux
# (glibc) wheels; this attempts the install exactly as QML1 would, from the same pinned
# requirements, and is recorded as it fails or succeeds. No workaround is attempted.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund
COPY tsconfig*.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache python3 py3-pip
RUN python3 -m venv /opt/venv
COPY scripts/qml1-size/requirements.txt /opt/requirements.txt
RUN /opt/venv/bin/pip install --no-cache-dir --require-hashes -r /opt/requirements.txt
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8080
CMD ["node", "dist/main.js"]
