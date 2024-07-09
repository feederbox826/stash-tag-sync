FROM alpine:3
WORKDIR /app
RUN apk add --no-cache \
    nodejs \
    npm && \
    npm i

COPY app /app/
CMD ["node", "tag-export.mjs"]