"use strict";

const DEFAULT_RELAY_SESSION_HOURS = 24;
const MAX_RELAY_SESSION_HOURS = 24 * 30;

function getRelaySessionWindowMs() {
  const raw = Number(process.env.CORTEX_RELAY_SESSION_HOURS || "");
  const hours = Number.isFinite(raw) && raw > 0
    ? Math.min(raw, MAX_RELAY_SESSION_HOURS)
    : DEFAULT_RELAY_SESSION_HOURS;
  return hours * 60 * 60 * 1000;
}

function computeRelaySessionExpiresAt(nowMs = Date.now()) {
  return new Date(nowMs + getRelaySessionWindowMs()).toISOString();
}

function isRelaySessionExpired(expiresAt, nowMs = Date.now()) {
  if (!expiresAt) return false;
  const parsed = Date.parse(String(expiresAt));
  if (!Number.isFinite(parsed)) return true;
  return nowMs >= parsed;
}

module.exports = {
  DEFAULT_RELAY_SESSION_HOURS,
  computeRelaySessionExpiresAt,
  getRelaySessionWindowMs,
  isRelaySessionExpired,
};
