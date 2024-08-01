FROM node:lts-alpine
WORKDIR /app
COPY app .
RUN npm i

CMD ["node", "tag-export.mjs"]