# Static-host image for the qemu-pmb887x wasm page, meant to run behind
# the perk11/nginx-proxy front (github.com/perk11/nginx-proxy:
# jwilder/nginx-proxy + letsencrypt companion) on the external
# `nginx-proxy` docker network.
#
# Build order matters: scripts/bundle-dist.sh must have produced ./dist
# (the webroot: page + dist/, dist-jit/ artifacts + .gz sidecars).
# The build context is the repo root — /.dockerignore trims it to just
# dist/ + deploy/nginx/, so the multi-GB qemu/ submodule is never sent
# to the daemon.
FROM nginx:stable-alpine

COPY deploy/nginx/site.conf /etc/nginx/conf.d/default.conf
COPY dist/ /usr/share/nginx/html/

EXPOSE 80
