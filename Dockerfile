FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
# better-sqlite3 ships prebuilt binaries for most platforms, but when none match this
# image's exact Node/alpine/arch combination npm falls back to compiling from source,
# which needs a toolchain alpine does not ship by default.
RUN apk add --no-cache --virtual .build python3 make g++ \
  && npm ci \
  && apk del .build
COPY . .
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
# better-sqlite3 ships prebuilt binaries for most platforms, but when none match this
# image's exact Node/alpine/arch combination npm falls back to compiling from source,
# which needs a toolchain alpine does not ship by default. Installing it only for the
# `npm ci` below and removing it again keeps those build tools out of the final image.
RUN apk add --no-cache --virtual .build python3 make g++ \
  && npm ci --omit=dev \
  && apk del .build \
  && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/drizzle ./drizzle
# Only /data needs to be writable by the `node` user (that's where the sqlite file
# lives) — everything under /app is read-only at runtime and stays root-owned but
# world-readable (npm's default), so this doesn't need a recursive chown of /app, which
# would otherwise duplicate the whole node_modules/dist layer under alpine's overlay fs.
RUN mkdir -p /data && chown -R node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server/index.js"]
