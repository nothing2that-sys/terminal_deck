const { app } = require('electron');
const { runElevatedPtyBroker } = require('./elevated-pty-broker');

function start(config) {
  app.whenReady()
    .then(() => runElevatedPtyBroker(config, {
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath
    }))
    .catch((error) => {
      console.error(`PTY broker를 시작하지 못했습니다: ${error.message}`);
      app.exit(1);
    });
}

module.exports = { start };
