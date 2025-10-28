FROM alpine:edge AS builder
RUN apk add nodejs pnpm openssl
WORKDIR /app
COPY app .
RUN pnpm install --frozen-lockfile
COPY . .

FROM alpine:latest
RUN apk add --no-cache nodejs
WORKDIR /app
COPY --from=builder /app .

EXPOSE 3000
CMD node tag-export.mjs