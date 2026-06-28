FROM alpine:3.18.4

RUN apk add --no-cache nodejs npm

WORKDIR /api

COPY api/package*.json ./

RUN npm install

RUN npm install -G mongoose cors

COPY /api /api

CMD ["npm", "start"]

EXPOSE 3070