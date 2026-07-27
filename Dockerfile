# syntax=docker/dockerfile:1

# Self-hosting build for the Scratch editor behind Kiwi's Traefik at the
# /scratch/ path prefix (Traefik strips the prefix; webpack's runtime publicPath
# resolves assets under it). Mirrors the static-serve pattern of the other Kiwi
# apps (e.g. teachable-machine): build the npm-workspaces monorepo, then serve
# the generated scratch-gui bundle with nginx.

# Node pinned to the repo's .nvmrc so the native `canvas` build matches.
FROM node:24.18.0-bookworm AS builder

# Native toolchain + libraries required to compile the `canvas` dependency
# (pulled in by scratch-svg-renderer). Without these, `npm ci` fails building it.
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential python3 pkg-config \
        libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev \
    && rm -rf /var/lib/apt/lists/*

# The root `prepare` script runs `husky install`, which needs a .git directory.
# The docker build context has none, so skip husky (other install scripts, e.g.
# scratch-gui's microbit-firmware download, still run).
ENV HUSKY=0
# scratch-gui's webpack build is memory hungry; give Node enough headroom.
ENV NODE_OPTIONS=--max-old-space-size=4096

WORKDIR /app
COPY . .

RUN npm ci
# Production build. NODE_ENV=production yields the minified editor in
# packages/scratch-gui/build -- the artifact nginx serves below.
#
# Memory-lean for small self-hosted build hosts (kiwi fork changes):
#   - scratch-gui's `build` script builds ONLY build:dev (-> build/, the served
#     editor). Upstream also builds dist/ + dist-standalone (library bundles we
#     never ship) -- 3x the webpack work; we dropped the two unused ones.
#   - webpack.config.js disables source maps in production (the base config's
#     'cheap-module-source-map' was the main driver of the multi-GB peak RSS).
# Together these keep the single remaining webpack run well under the heap cap
# above so it no longer OOMs a ~8GB host running the live services alongside it.
RUN NODE_ENV=production npm run build

FROM nginx:alpine
COPY --from=builder /app/packages/scratch-gui/build /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
