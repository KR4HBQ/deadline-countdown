FROM node:22-alpine

WORKDIR /app
COPY server.js ./
COPY public ./public

# /data holds config.js so your countdowns survive container updates.
# It is created owned by the "node" user so a fresh named volume is writable.
RUN mkdir -p /data && chown node:node /data

ENV PORT=8080 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    NODE_ENV=production

VOLUME /data
EXPOSE 8080
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1

CMD ["node", "server.js"]
