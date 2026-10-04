"use strict";

const express = require("express");
const cors = require("cors");
const path = require("path");
const entitlementRouter = require("./routes/entitlement");
const adminRouter = require("./routes/admin");

const PORT = Number(process.env.PORT) || 3000;

function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "16kb" }));

  app.get("/health", (req, res) => {
    res.json({ status: "ok", service: "minitok-entitlement", time: new Date().toISOString() });
  });

  app.use("/api/entitlement", entitlementRouter);
  app.use("/api/admin", adminRouter);

  // Homepage: license purchase/management page (Phase 5 placeholder UI).
  app.use(express.static(path.join(__dirname, "public")));
  app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
  });

  // JSON error handler — keeps stack traces out of client responses.
  app.use((err, req, res, next) => {
    if (err && err.type === "entity.parse.failed") {
      return res.status(400).json({ error: "Request body must be valid JSON." });
    }
    console.error("Unhandled error:", err);
    return res.status(500).json({ error: "Internal server error." });
  });

  return app;
}

if (require.main === module) {
  const app = createApp();
  app.listen(PORT, () => {
    console.log(`minitok entitlement server listening on http://localhost:${PORT}`);
  });
}

module.exports = { createApp };
