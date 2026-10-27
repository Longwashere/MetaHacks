# Build from the repo root: docker build -f backend/Dockerfile -t metahacks-backend .
FROM node:24-alpine AS build-env
COPY . /app
WORKDIR /app
RUN npm ci -w backend && npm run build -w backend

FROM node:24-alpine
COPY ./package.json package-lock.json /app/
COPY ./backend/package.json /app/backend/
WORKDIR /app
RUN npm ci -w backend --omit=dev
COPY --from=build-env /app/backend/dist /app/backend/dist
WORKDIR /app/backend
CMD ["npm", "run", "start"]
