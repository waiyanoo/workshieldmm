# =============================================================================
# Web image — the built SPA behind nginx.
#
# VITE_API_URL is compiled INTO the bundle, so it is a build argument, not a
# runtime variable. Staging and production are different images; there is no
# way to repoint a built bundle at another API without rebuilding it.
#
#   docker build -f apps/web/Dockerfile \
#     --build-arg VITE_API_URL=https://api.example.com \
#     -t workshield-web .
#
# Build from the REPO ROOT — npm workspace, lockfile at the top.
# =============================================================================

FROM node:22-bookworm-slim AS build
WORKDIR /app

ARG VITE_API_URL
# Fail the build rather than silently baking in the localhost default from
# config.ts. A bundle pointing at http://localhost:4000 looks fine until it is
# deployed, where every request fails in the user's browser.
RUN test -n "$VITE_API_URL" || (echo "VITE_API_URL build-arg is required" && exit 1)
ENV VITE_API_URL=$VITE_API_URL

# tsconfig.base.json too: every workspace tsconfig extends it.
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci

COPY packages/shared packages/shared
COPY apps/web apps/web

# Vite aliases @hyper/shared to TypeScript source, but the build script is
# `tsc --noEmit && vite build`, and tsc resolves the package through
# node_modules to its compiled .d.ts files. So shared is built first even though
# the bundler never reads the output.
RUN npm run build -w @hyper/shared  && npm run build -w @hyper/web

# --- runtime ----------------------------------------------------------------
FROM nginx:1.27-alpine AS runtime

COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
