FROM node:20.18-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20.18-alpine
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache libreoffice font-noto ttf-dejavu \
  && mkdir -p /app/server/.data/uploads \
  && chown -R node:node /app
COPY --chown=node:node server/package.json server/package-lock.json ./server/
RUN npm ci --prefix server --omit=dev && npm cache clean --force
COPY --chown=node:node server/src ./server/src
COPY --chown=node:node --from=build /app/dist ./dist
USER node
ENV PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "server/src/index.js"]
