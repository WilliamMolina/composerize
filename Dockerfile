# This is the base for our build step container
# which has all our build essentials
FROM node:8-alpine AS buildstep

# Copy in package.json, install 
# and build all node modules
WORKDIR /usr/src/app
COPY package.json .
RUN npm install yarn && yarn install && rm -rf /tmp/*

# This is our runtime container that will end up
# running on the device.
FROM node:8-alpine
WORKDIR /usr/src/app
RUN  apk add --update bash
# Copy our node_modules into our deployable container context.
COPY --from=buildstep /usr/src/app/node_modules node_modules
COPY . .
