FROM node:20-alpine
WORKDIR /app
COPY . .
ENV RELAY_DATA=/data RELAY_PORT=41811
VOLUME /data
EXPOSE 41811
USER node
CMD ["node", "relay.js"]
