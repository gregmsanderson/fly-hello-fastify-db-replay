# use slim, not alpine: the alpine ones are smaller but sometimes have issues with dns resolving
# and prisma is unlikely to work
FROM node:16.13-slim

# avoid prisma openssl errors
RUN apt-get -qy update && apt-get -qy install openssl

# it's recommended to run an app as a non-root user. Handily this image comes with a 'node' user
USER node

RUN mkdir -p /home/node/app
WORKDIR /home/node/app

COPY --chown=node:node package*.json .
RUN npm ci --only=production

COPY --chown=node:node . .

# update the prisma client based on the prisma schema
RUN npx prisma generate

CMD [ "node", "src/server.js" ]