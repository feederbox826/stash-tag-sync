FROM alpine:3
WORKDIR /app
COPY app .
RUN apk add --no-cache \
    nodejs \
    npm && \
    npm i

CMD ["node", "tag-export.mjs"]