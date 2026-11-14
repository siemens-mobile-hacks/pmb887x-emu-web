# syntax=docker/dockerfile:1
#
# bts-emulator's GPRS gateway (gprs-gw/server.mjs + the slirp-pipe helper)
# on its own, for the emulator page's /gprs WebSocket. See README.md.
#
# The gateway's two source files come from the named build context `bts`, a
# bts-emulator checkout of branch gprs-gw, and must match gprs-gw.sha256
# (commit 55c911aba7be4d00a7e6ada36e73a55e21a2e931):
#
#   docker build --build-context bts=../bts-emulator -t pmb887x-gprs-gw deploy/gprs-gw
#
# deploy/nginx/docker-compose.yml passes it as additional_contexts.

FROM node:24.22.1-trixie-slim@sha256:89c5244bc22a9bc3287d89ebc7e49b9cb5bb84cd40e6175ac3421d5a9f68b95a AS base

# Overridden by --build-context bts=...; without one, the COPY below fails
# instead of pulling some image called "bts".
FROM scratch AS bts

# slirp-pipe needs libslirp >= 4.9 (slirp_pollfds_fill_socket); Debian 13
# has 4.8.0, so it is linked statically against an upstream release.
FROM base AS build
RUN apt-get update \
	&& apt-get install --no-install-recommends -y \
		gcc=4:14.2.0-1 libc6-dev=2.41-12+deb13u4 pkg-config=1.8.1-4 \
		meson=1.7.0-1 ninja-build=1.12.1-1 libglib2.0-dev=2.84.4-3~deb13u5 xz-utils=5.8.1-1+deb13u2 \
	&& rm -rf /var/lib/apt/lists/*
ADD --checksum=sha256:d76df61220a55c429f8637a550168d8d4cc66e4606d64c178ff5929c004cbece \
	https://gitlab.freedesktop.org/-/project/2767/uploads/128da958c5bca62a4b7eae695abff645/libslirp-4.9.7.tar.xz /src/
RUN tar -xJf /src/libslirp-4.9.7.tar.xz -C /src \
	&& meson setup /src/build /src/libslirp-4.9.7 --buildtype=release -Ddefault_library=static \
		--prefix=/usr/local --libdir=lib \
	&& ninja -C /src/build install
WORKDIR /build
COPY gprs-gw.sha256 package.json package-lock.json ./
COPY --from=bts gprs-gw/server.mjs gprs-gw/slirp-pipe.c ./
# pkg-config's flags are meant to split into words
# hadolint ignore=SC2046
RUN sha256sum -c gprs-gw.sha256 \
	&& gcc -O2 -Wall -o slirp-pipe slirp-pipe.c $(pkg-config --cflags --libs slirp) \
	&& npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM base
RUN apt-get update \
	&& apt-get install --no-install-recommends -y libglib2.0-0t64=2.84.4-3~deb13u5 \
	&& rm -rf /var/lib/apt/lists/* \
	&& install -d -o node -g node -m 0750 /var/lib/gprs-gw
COPY --from=build /build/slirp-pipe /usr/local/bin/slirp-pipe
COPY --from=build /build/server.mjs /build/package.json /opt/gprs-gw/
COPY --from=build /build/node_modules /opt/gprs-gw/node_modules
COPY healthcheck.mjs /opt/gprs-gw/

ENV NODE_ENV=production \
	GPRS_GW_LISTEN=0.0.0.0:5751 \
	GPRS_GW_HELPER=/usr/local/bin/slirp-pipe \
	GPRS_GW_STATE=/var/lib/gprs-gw/state.json
USER node
WORKDIR /opt/gprs-gw
VOLUME /var/lib/gprs-gw
EXPOSE 5751
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
	CMD ["node", "/opt/gprs-gw/healthcheck.mjs"]
CMD ["node", "/opt/gprs-gw/server.mjs"]
