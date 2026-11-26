'use strict';
// Export archives -> conversations for the chat store (chats.js add()).
//
// The shapes read (entry names inside the ZIP; any leading folder is allowed):
//
//   ChatGPT   Settings > Data controls > Export: <hash>-<date>.zip with
//             conversations.json (mapping tree per chat), chat.html, user.json.
//   Claude    Settings > Privacy > Export data: data-<date>-<n>.zip with
//             conversations.json (chat_messages per chat), users.json, projects.json.
//   Gemini    Google Takeout, "My Activity" with "Gemini Apps" selected:
//             takeout-<date>.zip with Takeout/My Activity/Gemini Apps/MyActivity.json
//             (activity format JSON: [{ header, title: "Prompted <words>", time,
//             safeHtmlItem: [{ html }] }]) or MyActivity.html (Takeout's default;
//             read best-effort). Gemini has no chat ids in Takeout, so each day
//             of prompts is one conversation, id gemini:day:<YYYY-MM-DD>.
//   Keep      Google Takeout with Keep: Takeout/Keep/<note>.json
//             ({ title, textContent, listContent, userEditedTimestampUsec, isTrashed }).
//             Each note is one entry, source "keep". Trashed notes are skipped.
//   Apple     privacy.apple.com "Request a copy of your data" with iCloud Notes:
//             a ZIP (sometimes inside another ZIP) with a folder per note holding
//             a .txt file and its attachments, under a path containing "Notes".
//             Each .txt is one entry, source "apple-notes". Attachments are skipped.
//
// Anything else in a ZIP is ignored. Nothing is extracted to disk and the ZIP
// itself is never changed or deleted.
const path = require('path');
const { openZip } = require('./zip');
const { parseExport } = require('./chats');

const MAX_ENTRY = 300 * 1024 * 1024;
const iso = (v) => { const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d.toISOString(); };

function htmlText(html) {
  return String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
}

// Gemini activity items -> one conversation per local day.
function geminiFromItems(items) {
  const days = new Map();
  for (const it of items) {
    const prompt = String(it.title || '').replace(/^Prompted\s*/i, '').trim();
    const at = iso(it.time);
    if (!prompt || !at) continue;
    const answer = htmlText((it.safeHtmlItem || []).map((h) => h && h.html).join('\n'));
    const key = at.slice(0, 10);
    if (!days.has(key)) days.set(key, []);
    days.get(key).push({ role: 'user', at, text: prompt });
    if (answer) days.get(key).push({ role: 'assistant', at, text: answer });
  }
  return Array.from(days, ([key, messages]) => {
    messages.sort((a, b) => a.at.localeCompare(b.at));
    const label = new Date(key + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
    return { id: 'gemini:day:' + key, source: 'gemini', title: 'Gemini, ' + label + ': ' + messages[0].text.slice(0, 60), created: messages[0].at, updated: messages[messages.length - 1].at, messages };
  });
}
function parseGeminiJson(json) {
  const items = (Array.isArray(json) ? json : []).filter((it) => it && (/gemini/i.test(it.header || '') || (it.products || []).some((p) => /gemini/i.test(p))));
  return geminiFromItems(items);
}
// Takeout's default HTML: one "outer-cell" per activity. The prompt follows
// "Prompted", the date is the line after it, the answer is the rest.
function parseGeminiHtml(html) {
  const items = [];
  for (const cell of String(html || '').split(/class="outer-cell/).slice(1)) {
    const content = /class="content-cell[^"]*"[^>]*>([\s\S]*?)<\/div>([\s\S]*)/.exec(cell);
    if (!content) continue;
    const lines = htmlText(content[1]).split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length || !/^Prompted/i.test(lines[0])) continue;
    const dateLine = lines.find((l, i) => i > 0 && !Number.isNaN(Date.parse(l.replace(/\s+[A-Z]{2,5}$/, ''))));
    const prompt = lines.slice(0, dateLine ? lines.indexOf(dateLine) : 1).join(' ');
    const time = dateLine ? Date.parse(dateLine.replace(/\s+[A-Z]{2,5}$/, '')) : NaN;
    const rest = htmlText(content[2].split(/class="content-cell[^"]*mdl-typography--caption/)[0]);
    items.push({ header: 'Gemini Apps', title: prompt, time: Number.isNaN(time) ? null : new Date(time).toISOString(), safeHtmlItem: [{ html: rest }] });
  }
  return geminiFromItems(items);
}
function parseKeepNote(json, name) {
  if (!json || json.isTrashed) return null;
  const list = Array.isArray(json.listContent) ? json.listContent.map((l) => (l.isChecked ? '[x] ' : '[ ] ') + (l.text || '')).join('\n') : '';
  const text = [json.textContent || '', list].filter(Boolean).join('\n').trim();
  if (!text) return null;
  const at = json.userEditedTimestampUsec ? new Date(Number(json.userEditedTimestampUsec) / 1000).toISOString() : null;
  const title = String(json.title || '').trim() || text.split('\n')[0].slice(0, 60);
  return { id: 'keep:' + path.posix.basename(name, '.json'), source: 'keep', title, created: at, updated: at, messages: [{ role: 'user', at, text }] };
}
function appleNote(text, name) {
  const body = String(text || '').trim();
  if (!body) return null;
  const parts = name.split('/');
  const title = (parts.length > 1 ? parts[parts.length - 2] : path.posix.basename(name, '.txt')).replace(/[-_]\d+$/, '').trim() || body.split('\n')[0].slice(0, 60);
  return { id: 'applenotes:' + name.toLowerCase(), source: 'apple-notes', title, created: null, updated: null, messages: [{ role: 'user', at: null, text: body }] };
}

const isConversations = (n) => /(^|\/)conversations\.json$/i.test(n) && n.split('/').length <= 3;
const isGeminiJson = (n) => /(^|\/)my activity\/gemini apps\/myactivity\.json$/i.test(n);
const isGeminiHtml = (n) => /(^|\/)my activity\/gemini apps\/myactivity\.html$/i.test(n);
const isKeep = (n) => /(^|\/)takeout\/keep\/[^/]+\.json$/i.test(n);
const isAppleNote = (n) => /(^|\/)[^/]*notes[^/]*\/(.+\/)?[^/]+\.txt$/i.test(n) && !/(^|\/)takeout\//i.test(n);
const isNestedNotesZip = (n) => /notes[^/]*\.zip$/i.test(n);

// What a ZIP holds, from its directory alone (no entry is read). null: nothing to import.
function identify(entries) {
  const names = entries.map((e) => e.name);
  const kinds = [];
  if (names.some(isConversations)) kinds.push('chats');
  if (names.some((n) => isGeminiJson(n) || isGeminiHtml(n))) kinds.push('gemini');
  if (names.some(isKeep)) kinds.push('keep');
  if (names.some(isAppleNote) || names.some(isNestedNotesZip)) kinds.push('apple-notes');
  return kinds.length ? kinds : null;
}

// A ZIP (path or Buffer) -> { kinds, conversations, skipped }.
function readExportZip(src, { depth = 0 } = {}) {
  const zip = openZip(src);
  try {
    const kinds = identify(zip.entries);
    const out = [];
    const skipped = [];
    if (!kinds) return { kinds: null, conversations: out, skipped };
    const text = (e) => zip.read(e, MAX_ENTRY).toString('utf8').replace(/^﻿/, '');
    for (const e of zip.entries) {
      try {
        if (isConversations(e.name)) out.push(...parseExport(JSON.parse(text(e))));
        else if (isGeminiJson(e.name)) out.push(...parseGeminiJson(JSON.parse(text(e))));
        else if (isGeminiHtml(e.name) && !zip.entries.some((x) => isGeminiJson(x.name))) out.push(...parseGeminiHtml(text(e)));
        else if (isKeep(e.name)) { const n = parseKeepNote(JSON.parse(text(e)), e.name); if (n) out.push(n); }
        else if (isAppleNote(e.name)) { const n = appleNote(text(e), e.name); if (n) out.push(n); }
        else if (isNestedNotesZip(e.name) && depth < 1) out.push(...readExportZip(zip.read(e, MAX_ENTRY), { depth: depth + 1 }).conversations);
      } catch (err) { skipped.push(e.name + ': ' + err.message); }
    }
    return { kinds, conversations: out, skipped };
  } finally { zip.close(); }
}

const SOURCE_NAMES = { claude: 'Claude', chatgpt: 'ChatGPT', gemini: 'Gemini', keep: 'Google Keep', 'apple-notes': 'Apple Notes', ai: 'AI chats' };
// "Imported 12 conversations from ChatGPT", "... 40 notes from Google Keep and 3 conversations from Gemini".
function importedLine(list) {
  const by = new Map();
  for (const c of list) by.set(c.source, (by.get(c.source) || 0) + 1);
  const parts = Array.from(by, ([s, n]) => n + ' ' + (s === 'keep' || s === 'apple-notes' ? (n === 1 ? 'note' : 'notes') : (n === 1 ? 'conversation' : 'conversations')) + ' from ' + (SOURCE_NAMES[s] || s));
  return parts.length ? 'Imported ' + parts.join(' and ') : '';
}

module.exports = { readExportZip, identify, parseGeminiJson, parseGeminiHtml, parseKeepNote, importedLine, htmlText, SOURCE_NAMES };
