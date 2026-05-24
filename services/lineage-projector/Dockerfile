FROM node:20-alpine AS build
WORKDIR /workspace
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages ./packages
COPY services ./services
RUN corepack enable && pnpm install --frozen-lockfile && pnpm -w build

FROM node:20-alpine AS runtime
WORKDIR /app
COPY --from=build /workspace /app
EXPOSE 8081
ENV NODE_ENV=production
CMD ["node", "services/lineage-projector/dist/index.js"]
