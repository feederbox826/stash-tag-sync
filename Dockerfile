FROM alpine:3
WORKDIR /app
RUN apk add --no-cache \
    nodejs \
    npm && \
    cd /app && \
    npm i axios file-type

COPY app /app/
CMD ["node", "tag-export.mjs"]