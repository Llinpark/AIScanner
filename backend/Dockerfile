FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .
RUN chown -R node:node /app

USER node

EXPOSE 8080

CMD ["node", "server.js"]
