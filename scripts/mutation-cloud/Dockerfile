FROM node:24.22.1-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl procps python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.19.0 --activate
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
WORKDIR /repo
COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm install --frozen-lockfile --ignore-scripts && pnpm rebuild better-sqlite3 ffmpeg-static
COPY src ./src
COPY scripts ./scripts
COPY test ./test
COPY extension ./extension
COPY stryker.config.mts ./
ENTRYPOINT ["sh", "/repo/scripts/mutation-cloud/entrypoint.sh"]
