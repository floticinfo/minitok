"use strict";

/**
 * Base error class for all minitok errors.
 *
 * Named MinitokError (PascalCase) per JavaScript convention.
 * `minitokError` is kept as a deprecated alias for backward compatibility
 * with any external code that may have caught or type-checked the class.
 */
class MinitokError extends Error {
  constructor(message) {
    super(message);
    this.name = "MinitokError";
  }
}

// Backward-compatible alias — existing code may reference `minitokError` in
// catch blocks or `instanceof` checks.
const minitokError = MinitokError;

class WorkspaceError extends MinitokError {
  constructor(message) {
    super(message);
    this.name = "WorkspaceError";
  }
}

class AuthError extends MinitokError {
  constructor(message) {
    super(message);
    this.name = "AuthError";
  }
}

class ConfigError extends MinitokError {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
}

class PipelineError extends MinitokError {
  constructor(message) {
    super(message);
    this.name = "PipelineError";
  }
}

class AdapterError extends MinitokError {
  constructor(message) {
    super(message);
    this.name = "AdapterError";
  }
}

class GitError extends MinitokError {
  constructor(message, options = {}) {
    super(message);
    this.name = "GitError";
    this.code = options.code;
    this.command = options.command;
    this.status = options.status;
  }
}

class MigrationError extends MinitokError {
  constructor(message) {
    super(message);
    this.name = "MigrationError";
  }
}

module.exports = {
  MinitokError,
  minitokError,
  WorkspaceError,
  AuthError,
  ConfigError,
  PipelineError,
  AdapterError,
  GitError,
  MigrationError,
};
