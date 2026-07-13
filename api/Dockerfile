FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/package.json
COPY api/package.json api/package.json
COPY web/package.json web/package.json
RUN npm ci --workspace shared --workspace api --include-workspace-root
COPY tsconfig.base.json ./
COPY shared shared
COPY api api
RUN npm run build -w shared && npm run build -w api

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/package.json
COPY api/package.json api/package.json
COPY web/package.json web/package.json
RUN npm ci --omit=dev --workspace shared --workspace api --include-workspace-root \
  && npm cache clean --force
COPY --from=build /app/shared/dist shared/dist
COPY --from=build /app/api/dist api/dist
COPY api/migrations api/migrations
USER node
EXPOSE 8000
CMD ["node", "api/dist/index.js"]
