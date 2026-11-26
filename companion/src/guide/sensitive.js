'use strict';
// Fields the thread never points at: passwords, card numbers, identity
// numbers, one-time codes. Enforced here, in code, on every pointing path
// (model pick, quick pick, replay), because a prompt is not a boundary and
// replay uses no model at all. The field's value is never inspected or kept.

const NAME_RE = /\b(password|passcode|passwd|pwd|pin|cvv|cvc|ssn|passport|otp)\b|\b(?:card|credit|debit|account|routing|social security|national id|government id|tax id|driver.?s? licen[cs]e)\s*(?:number|no|num)?\b|\b(?:security|verification|one time)\s*code\b/;
const FIELD_TYPES = new Set(['edit', 'combobox', 'textbox', 'password', 'document']);

function normalize(text) {
  return String(text || '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ').toLowerCase();
}

// element: { name, label?, automationId?, type?, isPassword?, sensitive? }
function sensitiveTarget(element) {
  if (!element) return false;
  if (element.isPassword === true || element.sensitive === true) return true;
  const type = String(element.type || '').toLowerCase();
  if (type && !FIELD_TYPES.has(type)) return false;
  return NAME_RE.test(normalize([element.name, element.label, element.automationId].filter(Boolean).join(' ')));
}

// A value that reads like a secret: eight or more digits in a row, with or
// without spaces and dashes (card, account and identity numbers).
function looksSecret(value) {
  return /(?:\d[\s-]?){8,}/.test(String(value || ''));
}

// The one line the Knot says instead of pointing.
const REFUSAL = 'That is a private field, so I will not point at it. Fill it in yourself and tell me when you are done.';

module.exports = { sensitiveTarget, looksSecret, REFUSAL };
