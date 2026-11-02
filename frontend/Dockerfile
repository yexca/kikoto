FROM node:24.22.1@sha256:6449e19d8184d84062525b6a7524def03146c2cb04a7f08b076680d0e8e4240a AS build

WORKDIR /src/frontend
COPY frontend/package*.json frontend/.npmrc ./
RUN npm ci --strict-allow-scripts
COPY VERSION /src/VERSION
COPY frontend/ ./
RUN npm run build

FROM nginx:1.31-alpine@sha256:785835ea65db4bba6f021acc0f3be91b0fef76a53fe41f8588c6698d2aed0606
COPY --from=build /src/frontend/dist /usr/share/nginx/html
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY frontend/nginx-security.conf /etc/nginx/kikoto-security.conf
COPY LICENSE /usr/share/nginx/html/LICENSE
EXPOSE 80
