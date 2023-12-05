FROM alpine:3.18.4

RUN apk add --no-cache nodejs npm

WORKDIR /react-docker

COPY react-docker/package*.json ./

RUN npm install
RUN npm i axios

COPY /react-docker /react-docker

CMD ["npm", "start"]

EXPOSE 3000