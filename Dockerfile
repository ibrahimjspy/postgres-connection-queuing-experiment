FROM node:24-alpine
WORKDIR /lab
COPY package*.json ./
RUN npm ci --omit=dev
COPY lab ./lab
USER node
CMD ["node", "lab/api.mjs"]
