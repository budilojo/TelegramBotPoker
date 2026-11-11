FROM node:24-bookworm-slim
WORKDIR /opt/cardgame
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY bot ./bot
COPY miniapp ./miniapp
COPY server ./server
COPY docs/next-release/legal ./docs/next-release/legal
COPY tools/ux-start.mjs ./tools/ux-start.mjs
RUN mkdir data-ux && chown node:node data-ux
USER node
CMD ["npm", "run", "ux"]
