FROM node:22-bookworm-slim
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY server/ ./
ENV NODE_ENV=production
USER node
EXPOSE 3000
CMD ["node", "index.js"]
