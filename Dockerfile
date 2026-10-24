# Node 22 retains the ARMv7 image supported by this repository.
ARG NODE_VERSION="22"
ARG BASE_IMAGE="node:${NODE_VERSION}-alpine"
FROM ${BASE_IMAGE} AS build
WORKDIR /workspace
COPY package.json package-lock.json ./
RUN npm ci
COPY . ./
RUN npm test && npm prune --omit=dev

FROM ${BASE_IMAGE} AS app
WORKDIR /data
COPY --from=build /workspace/node_modules /app/node_modules
COPY --from=build /workspace/dist /app/dist
COPY --from=build /workspace/config-sample.yaml /app/config-sample.yaml
CMD ["node", "/app/dist/main.js"]

FROM app AS addon
ENV RISCO_MQTT_HA_CONFIG_FILE="/config/risco-mqtt.json"
ENV RISCO_MQTT_HA_CONFIG_YAML="/config/risco-mqtt.yaml"

# Keep a plain docker build equivalent to the standalone service.
FROM app AS runtime
