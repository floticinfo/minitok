"use strict";

/**
 * Select the cheapest safe edit representation from the planned files.
 * The policy is deliberately conservative: new files and explicit full-file
 * requests never use Edit IR, while explicit edit_ir remains available for
 * callers that already proved the task benefits from it.
 */
function chooseEditRepresentation(options = {}) {
  const requested = ["full_file", "edit_ir", "adaptive"].includes(options.requested) ? options.requested : "full_file";
  if (requested === "full_file") return { representation: "full_file", reason: "explicit_full_file" };
  if (requested === "edit_ir") return { representation: "edit_ir", reason: "explicit_edit_ir" };
  if (options.optimization_allowed === false) return { representation: "full_file", reason: "optimization_not_allowed" };

  const files = Array.isArray(options.files) ? options.files : [];
  if (!files.length) return { representation: "full_file", reason: "no_existing_manifest_files" };
  if (files.some(file => file?.action === "create" || file?.action === "delete")) return { representation: "full_file", reason: "new_or_deleted_file" };
  const maxBytes = Math.max(1, Number(options.small_file_max_bytes) || 1600);
  const totalBytes = files.reduce((sum, file) => sum + (Number(file?.bytes) || 0), 0);
  if (files.length === 1 && totalBytes <= maxBytes) return { representation: "full_file", reason: "small_single_file" };
  return { representation: "edit_ir", reason: files.length > 1 ? "multi_file_change" : "large_existing_file" };
}

module.exports = { chooseEditRepresentation };
