# QML1-SIZE variants D and E, in one file.
#
#   --target scheduler  (D) the scheduler image QML1 would ship: C + python3 + CPU-only
#                           torch + granite-tsfm, with the TTM weights baked in.
#   --target api        (E) the api image when torch lives only in the scheduler target.
#
# Python and the weights come before the Node runtime layers, so a change under src/
# rebuilds the dist copy and nothing below it. The weights are fetched at build time,
# at a pinned revision, and the runtime is told to stay offline: a container that
# downloads its model on first start makes cold start depend on Hugging Face.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund
COPY tsconfig*.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS api
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8080
CMD ["node", "dist/main.js"]

FROM node:22-bookworm-slim AS scheduler
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv \
 && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/venv
COPY scripts/qml1-size/requirements.txt /opt/requirements.txt
# The lock is the whole closure, so pip installs exactly it (--no-deps) rather than
# re-resolving: hash mode refuses an extra such as transformers[torch] that it resolves
# to a version the lock does not hold. `pip check` then fails the build if the lock
# is ever missing something a package needs.
RUN /opt/venv/bin/pip install --no-cache-dir --no-deps --require-hashes -r /opt/requirements.txt \
 && /opt/venv/bin/pip check
ARG TTM_MODEL=ibm-granite/granite-timeseries-ttm-r2
ARG TTM_REVISION=d6a79570cac0f33d526601cd3a0fc7c80a8f9a2f
RUN /opt/venv/bin/python -c "from huggingface_hub import snapshot_download; snapshot_download('${TTM_MODEL}', revision='${TTM_REVISION}', local_dir='/opt/models/ttm-r2', allow_patterns=['config.json', 'generation_config.json', 'model.safetensors'])"
ENV HF_HUB_OFFLINE=1 TTM_MODEL_DIR=/opt/models/ttm-r2
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8080
CMD ["node", "dist/main.js"]
