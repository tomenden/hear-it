FROM node:22-slim AS base
WORKDIR /app
RUN corepack enable

COPY package.json .yarnrc.yml ./
COPY apps/api/package.json ./apps/api/package.json

RUN yarn install

FROM base AS build
COPY apps/api ./apps/api
RUN yarn workspace @hear-it/api build

FROM node:22-slim AS runtime
WORKDIR /app

COPY --from=base /app/package.json ./package.json
COPY --from=base /app/.yarnrc.yml ./.yarnrc.yml
COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/dist ./apps/api/dist

EXPOSE 3000

CMD ["node", "apps/api/dist/production.js"]
