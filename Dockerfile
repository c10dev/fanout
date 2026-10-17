# fanout dashboard in a container.
#   docker build -t fanout .
#   docker run -d -p 127.0.0.1:8780:8780 -e FANOUT_ASSUME_LOCAL=1 -v fanout-data:/data fanout
# Keep the published port on 127.0.0.1: with FANOUT_ASSUME_LOCAL=1 the dashboard treats every
# request as local (settings tab on, token embedded in the page).

FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build

FROM node:24-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY package.json LICENSE ./
ENV FANOUT_HOME=/data NODE_ENV=production
RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node
EXPOSE 8780
ENTRYPOINT ["node", "/app/dist/cli.js"]
CMD ["serve", "--host", "0.0.0.0", "--port", "8780"]
