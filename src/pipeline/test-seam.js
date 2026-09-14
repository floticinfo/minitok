"use strict";

const { PREAUTHORIZED } = require("./authorization");

// Test-only compatibility name. The actual marker lives in production code so
// the shipped CLI never imports this excluded module.
const TEST_AUTHORIZATION = PREAUTHORIZED;

module.exports = { TEST_AUTHORIZATION };
