"use strict";

const {
  DEFAULT_MODEL,
  CLAUDE_MODELS,
  CODEX_MODELS,
  GEMINI_CLI_MODELS,
  HERMES_MODELS,
  GEMINI_MODELS,
  GROQ_MODELS,
} = require("./constants");

// Providers in the order a new user should land on them. CLI providers count
// when their binary is installed; API providers only when a key is set.
// Each check is a function so later providers aren't probed (a `where`/`which`
// spawn each) once an earlier one matches.
const PREFERENCE = [
  [(s) => s.claudeProvider?.available, () => CLAUDE_MODELS[0][0]],
  [(s) => s.codexProvider?.available, (s) => s.defaultCodexModelId?.() || CODEX_MODELS[0][0]],
  [(s) => s.geminiCliProvider?.available, () => GEMINI_CLI_MODELS[0][0]],
  [(s) => s.hermesProvider?.available, () => HERMES_MODELS[0][0]],
  [(s) => s.geminiProvider?.connected, () => GEMINI_MODELS[0][0]],
  [(s) => s.groqProvider?.connected, () => GROQ_MODELS[0][0]],
];

/**
 * Model to use when the user hasn't picked one: the first installed (or
 * keyed) provider in PREFERENCE order. Falls back to DEFAULT_MODEL when
 * nothing is set up, so the UI still has something to show.
 */
function firstInstalledModel(service) {
  for (const [isReady, modelId] of PREFERENCE) {
    let ready = false;
    try {
      ready = Boolean(isReady(service));
    } catch {
      ready = false;
    }
    if (ready) {
      return modelId(service);
    }
  }
  return DEFAULT_MODEL;
}

/**
 * Whether the saved config model was picked by the user (and so must be
 * kept) rather than written as a default.
 *
 * Configs written before `model_explicit` existed always held DEFAULT_MODEL
 * after the first launch, picked or not. Keep that one only when Gemini CLI
 * is actually installed; otherwise it can't work and was never a real choice.
 */
function isExplicitModelChoice(config, service) {
  const saved = String(config?.model || "");
  if (!saved) {
    return false;
  }
  if (typeof config.modelExplicit === "boolean") {
    return config.modelExplicit;
  }
  if (saved === DEFAULT_MODEL) {
    return Boolean(service?.geminiCliProvider?.available);
  }
  return true;
}

module.exports = { firstInstalledModel, isExplicitModelChoice };
