# =============================================================================
# API image — also runs the worker and the migration runner.
#
# One image, three commands. The API, the background worker and the migrations
# must be the same build: a worker running last week's code against this week's
# schema is a class of bug that is miserable to diagnose, and sharing the image
# makes that impossible by construction.
#
#   API         node dist/index.js                (default)
#   Worker      node dist/jobs/worker.js
#   Migrations  node dist/db/migrate.js up        (as the OWNER role)
#
# Build from the REPO ROOT, not from apps/api — this is an npm workspace and the
# lockfile lives at the top:
#
#   docker build -f apps/api/Dockerfile -t workshield-api .
# =============================================================================

# Debian rather than Alpine on purpose: argon2 is a native module, and its
# prebuilt binaries are glibc. On musl it falls back to compiling from source,
# which needs python3 and a toolchain in the final image or a much more careful
# multi-stage dance. The size difference is not worth that.
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Manifests first, so `npm ci` is cached until a dependency actually changes.
# Every workspace package.json is needed for npm to resolve the workspace graph.
# tsconfig.base.json too: every workspace tsconfig extends it.
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/

# The web workspace is not built here, but npm ci installs the whole workspace
# graph regardless; it is dropped again in the runtime stage.
RUN npm ci

COPY packages/shared packages/shared
COPY apps/api apps/api

# Shared first: the API imports its compiled output, not its source.
RUN npm run build -w @hyper/shared \
 && npm run build -w @hyper/api

# Re-resolve with production dependencies only. Done after the build so
# devDependencies (typescript, vitest) are available above but absent below.
RUN npm ci --omit=dev

# --- runtime ----------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# This image only runs in production mode. The pretty log formatter is a
# devDependency and is absent here, so overriding NODE_ENV to development
# crashes at startup on a missing pino transport — by design, not a bug.
ENV NODE_ENV=production
# Several reporting queries pin AT TIME ZONE 'UTC' deliberately. A container in
# any other zone shifts the windows those queries report on.
ENV TZ=UTC

COPY --from=build /app/node_modules node_modules
COPY --from=build /app/package.json package.json
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/shared/package.json packages/shared/package.json
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/api/package.json apps/api/package.json

# The migration runner walks up from its own directory looking for db/migrations,
# so the monorepo layout has to be preserved here. Migrations are part of the
# image for the same reason the worker is: schema and code ship together.
COPY db db

# Drop privileges. `node` (uid 1000) ships with the official image.
USER node

EXPOSE 4000

# /health is a liveness check with no dependencies; /ready touches the database
# and is the one a load balancer should gate traffic on.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||4000)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# --init is NOT required: index.ts and worker.ts both install SIGTERM/SIGINT
# handlers and close their pools, so node as PID 1 shuts down cleanly.
CMD ["node", "apps/api/dist/index.js"]
