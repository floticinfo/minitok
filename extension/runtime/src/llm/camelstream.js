"use strict";

const CAMELSTREAM_PROVIDER = "camelstream";
const CAMELSTREAM_BASE_URL = "https://stream.camelai.com/v1";
const CAMELSTREAM_MODEL = "camel-stream/auto";
const CAMELSTREAM_CREDENTIAL_HANDLE = "CAMEL_API_KEY";
const CAMELSTREAM_CONTEXT_WINDOW = 260000;
function camelstreamPreset(extra = {}) {
  if (extra.api_key !== undefined) throw new Error("Camelstream accepts credential handles only; use CAMEL_API_KEY");
  if (extra.base_url !== undefined && extra.base_url !== CAMELSTREAM_BASE_URL) throw new Error(`Camelstream base_url must be ${CAMELSTREAM_BASE_URL}`);
  if (extra.api_key_env !== undefined && extra.api_key_env !== CAMELSTREAM_CREDENTIAL_HANDLE) throw new Error(`Camelstream api_key_env must be ${CAMELSTREAM_CREDENTIAL_HANDLE}`);
  if (Array.isArray(extra.models)) {
    const ids = extra.models.map(item => typeof item === "string" ? item : item?.id).filter(Boolean);
    if (!ids.includes(CAMELSTREAM_MODEL)) throw new Error(`Camelstream model allowlist must include ${CAMELSTREAM_MODEL}`);
  }
  return { ...extra, base_url: CAMELSTREAM_BASE_URL, api_key_env: CAMELSTREAM_CREDENTIAL_HANDLE, models: [{ id: CAMELSTREAM_MODEL, context_window: CAMELSTREAM_CONTEXT_WINDOW }], _name: CAMELSTREAM_PROVIDER, response_api: "responses" };
}
module.exports = { CAMELSTREAM_PROVIDER, CAMELSTREAM_BASE_URL, CAMELSTREAM_MODEL, CAMELSTREAM_CREDENTIAL_HANDLE, CAMELSTREAM_CONTEXT_WINDOW, camelstreamPreset };
