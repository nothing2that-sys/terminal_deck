const {
  BROKER_TOKEN_PREFIX,
  parseBrokerArguments
} = require('./elevated-pty-protocol');

let brokerStartup;
try {
  brokerStartup = parseBrokerArguments(process.argv);
  if (brokerStartup) {
    delete process.env.TERMINAL_DECK_BROKER_TOKEN;
    process.argv = process.argv.filter(
      (argument) => !argument.startsWith(BROKER_TOKEN_PREFIX)
    );
  }
} catch (error) {
  console.error(`PTY broker 인수가 유효하지 않습니다: ${error.message}`);
  process.exitCode = 1;
  brokerStartup = false;
}

if (brokerStartup) {
  require('./elevated-pty-entry').start(brokerStartup);
} else if (brokerStartup !== false) {
  require('./main');
}
