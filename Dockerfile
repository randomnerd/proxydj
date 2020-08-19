FROM node:12-alpine as BUILDER
RUN apk add wget ca-certificates
RUN mkdir /app
WORKDIR /app
# RUN wget -O proxy.tgz https://github.com/snail007/goproxy/releases/latest/download/proxy-linux-amd64_commercial.tar.gz
RUN wget -O proxy.tgz https://github.com/snail007/goproxy/releases/latest/download/proxy-linux-amd64.tar.gz
RUN tar xf proxy.tgz
RUN chmod +x proxy
COPY package.json ./
COPY yarn.lock ./
RUN yarn install
COPY . .
RUN yarn build

FROM node:12-alpine
RUN mkdir /app
WORKDIR /app
COPY --from=BUILDER /app/dist ./dist
COPY --from=BUILDER /app/proxy /usr/bin/proxy
COPY package.json .
COPY yarn.lock .
RUN yarn install --frozen-lockfile --link-duplicates --ignore-optional --prefer-offline --prod
COPY ./config ./config
CMD ["yarn", "start"]
