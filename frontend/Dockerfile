FROM node:20 AS build
WORKDIR /app

COPY package.json package-lock.json* .npmrc* ./
RUN npm ci --silent --no-progress

COPY . .

# Inject version info at build time; defaults allow local builds without args
ARG VITE_COMMIT_SHA=dev
ARG VITE_BUILD_TIME=local
ENV VITE_COMMIT_SHA=$VITE_COMMIT_SHA \
    VITE_BUILD_TIME=$VITE_BUILD_TIME

RUN npm run build

FROM nginx:1.27-alpine

COPY nginx/default.conf /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 3000
ENTRYPOINT ["/entrypoint.sh"]
