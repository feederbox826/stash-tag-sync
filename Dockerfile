FROM node:lts-alpine
WORKDIR /app
COPY app .
RUN npm i
RUN echo "0 0 * * * /usr/local/bin/node /app/tag-export.mjs" > /etc/crontabs/root

EXPOSE 3000
CMD node tag-export.mjs; crond -f