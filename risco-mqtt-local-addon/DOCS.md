# Risco MQTT Addon

## Configuration

The addon cannot be configured from the addon configuration page. In order to configure the addon, you need to add/edit the `/config/risco-mqtt.yaml` file and restart the addon.

For editing the configuration file, use the [Studio Code Server](https://github.com/hassio-addons/addon-vscode#readme) addon.

## Building from source

The addon just extends the risco-mqtt docker image. Therefore, if you make changes to the
source code of the risco-mqtt (and not the addon itself), you will need to rebuild the risco-mqtt image.
