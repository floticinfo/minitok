"use strict";

const { authorizeEntitlement } = require("../entitlement/policy");

class EntitlementService {
  constructor(entitlementDir, serverUrl) {
    this._dir = entitlementDir;
    this._serverUrl = serverUrl;
  }

  status(options = {}) {
    return authorizeEntitlement({ ...options, entitlementDir: this._dir, ...(options.serverUrl || this._serverUrl ? { serverUrl: options.serverUrl || this._serverUrl } : {}) });
  }
}

module.exports = { EntitlementService };
