// Integration tests need a live daemon. globalSetup starts it (and kills any stale one),
// globalTeardown kills it. Unit tests keep the base config and never pay that cost.
module.exports = {
  ...require('./jest.config.js'),
  testMatch: ['**/integration/**/*.test.ts'],
  globalSetup: '<rootDir>/test/globalSetup.ts',
  globalTeardown: '<rootDir>/test/globalTeardown.ts',
};
