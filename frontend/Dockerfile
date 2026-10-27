# Build from the repo root: docker build -f frontend/Dockerfile -t metahacks-frontend .
FROM node:24-alpine AS development-dependencies-env
COPY . /app
WORKDIR /app
RUN npm ci -w frontend

FROM node:24-alpine AS production-dependencies-env
COPY ./package.json package-lock.json /app/
COPY ./frontend/package.json /app/frontend/
WORKDIR /app
RUN npm ci -w frontend --omit=dev

FROM node:24-alpine AS build-env
COPY . /app/
COPY --from=development-dependencies-env /app/node_modules /app/node_modules
WORKDIR /app
RUN npm run build -w frontend

FROM node:24-alpine
COPY ./package.json package-lock.json /app/
COPY ./frontend/package.json /app/frontend/
COPY --from=production-dependencies-env /app/node_modules /app/node_modules
COPY --from=build-env /app/frontend/build /app/frontend/build
WORKDIR /app/frontend
CMD ["npm", "run", "start"]
