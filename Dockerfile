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

# Forensics-only Node diagnostic reports (fatal / uncaught). Files land in
# ephemeral /tmp and do not survive a Fly machine restart.
CMD ["node", "--report-on-fatalerror", "--report-uncaught-exception", "--report-directory=/tmp", "server.js"]
