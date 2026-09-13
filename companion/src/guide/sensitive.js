'use strict';

// Enforce this locally. A prompt is not a safety boundary, and replay does
// not use a model at all. Do not inspect or retain the field's value.
function sensitiveTarget(element) {
  if (!element) return false;
  if (element.isPassword === true || element.sensitive === true) return true;
  const type = String(element.type || '').toLowerCase();
  if (type && !['edit', 'combobox', 'textbox', 'password'].includes(type)) return false;
  const text = [element.name, element.label, element.automationId].filter(Boolean).join(' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ').toLowerCase();
  return /\b(password|passcode|passwd|pwd|pin|cvv|cvc|ssn|passport|otp)\b|\b(?:card|credit|debit|account|routing|social security|national id|government id|tax id|driver.?s? licen[cs]e)\s*(?:number|no|num)?\b|\b(?:security|verification|one time)\s*code\b/.test(text);
}

module.exports = { sensitiveTarget };
