# syntax=docker/dockerfile:1

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
RUN apk add --no-cache openssl
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN rm -f tsconfig.build.tsbuildinfo \
  && npx prisma generate && npm run build \
  && npx tsc prisma/seed.ts --outDir dist/seed --rootDir prisma --module commonjs --moduleResolution node --esModuleInterop --target ES2022 --skipLibCheck --declaration false --sourceMap false

FROM node:22-alpine AS runner
WORKDIR /app
RUN apk add --no-cache openssl libc6-compat
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY package.json ./
COPY scripts/render-start.sh ./scripts/render-start.sh
RUN chmod +x ./scripts/render-start.sh
EXPOSE 43121
CMD ["./scripts/render-start.sh"]
