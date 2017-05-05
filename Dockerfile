FROM node:6

WORKDIR /usr/src/app

COPY package.json .npmrc ./

RUN npm install -q

CMD ["node", "server"]

HEALTHCHECK CMD curl -f http://localhost:9999/ok || exit 1

COPY . ./
