"use strict";

// Internal marker used when an embedding caller has already completed the
// entitlement check. This is a production module because the CLI package must
// not depend on the excluded test-seam module.
const PREAUTHORIZED = Symbol("minitok-preauthorized");

module.exports = { PREAUTHORIZED };
