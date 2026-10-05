FROM node:24.19.0@sha256:934240a162082fd8b8a2f90cd5114446443f1eba1c5378f6687167ca405e6584 AS build

WORKDIR /src/frontend
COPY frontend/package*.json frontend/.npmrc ./
RUN npm ci --strict-allow-scripts
COPY VERSION /src/VERSION
COPY frontend/ ./
RUN npm run build

FROM nginx:1.31-alpine@sha256:df221db836e1754089190208cee7eeda94f233197056426eda74a43ab1abeac2
COPY --from=build /src/frontend/dist /usr/share/nginx/html
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY frontend/nginx-security.conf /etc/nginx/kikoto-security.conf
COPY LICENSE /usr/share/nginx/html/LICENSE
EXPOSE 80
