const path = require('path');
const fs = require('fs');
const outlook = require('./outlook');
const { app } = require('electron');

let profileDir = null;
const EMAIL_PROFILE = 'style_profile_email.json';

function init(userDataDir) {
  profileDir = path.join(userDataDir, 'style_profiles');
  fs.mkdirSync(profileDir, { recursive: true });
}

function profilePath(name) {
  return path.join(profileDir, name);
}

function loadProfile(name = EMAIL_PROFILE) {
  if (!profileDir) return null;
  try { return JSON.parse(fs.readFileSync(profilePath(name), 'utf8')); } catch { return null; }
}

function analyzeEmails(messages) {
  if (!messages || !messages.length) return { ready: false, exemplars: 0, reason: 'No sent emails found.' };
  const bodies = messages.map((m) => extractPlainText(m.body?.content || m.bodyPreview || ''));
  const signatures = bodies.map(deriveSignoff).filter(Boolean);
  const greetings = bodies.map(deriveGreeting).filter(Boolean);
  const sentences = bodies.flatMap((b) => b.split(/[.!?]+/).map((s) => s.trim()).filter(Boolean));
  const avgSentenceWords = sentences.length ? Math.round(sentences.reduce((sum, s) => sum + s.split(/\s+/).length, 0) / sentences.length) : 0;
  const longSentences = sentences.filter((s) => s.split(/\s+/).length >= 28).length;
  const formality = deriveFormality(bodies);
  const emojiCount = bodies.reduce((sum, b) => sum + (b.match(/\p{Extended_Pictographic}/gu) || []).length, 0);
  const exemplars = bodies.slice(0, 5).map((b) => b.slice(0, 1200));
  return {
    ready: true,
    exemplars: exemplars.length,
    avgSentenceWords,
    longSentenceRatio: sentences.length ? longSentences / sentences.length : 0,
    formality,
    emojiUsage: emojiCount,
    greeting: mode(greetings) || 'Hi',
    signoff: mode(signatures) || 'Best',
    exemplar_bodies: exemplars,
    built_at: new Date().toISOString(),
    source: 'outlook_sent',
    count: messages.length,
  };
}

function extractPlainText(htmlOrText) {
  if (!htmlOrText) return '';
  if (!/<[a-z!]/i.test(htmlOrText)) return htmlOrText;
  return htmlOrText
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\u00a0/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function deriveGreeting(body) {
  const first = body.split('\n')[0].trim();
  const m = first.match(/^(Dear|Hi|Hello|Hey|Dr\.|Professor|Greetings)\s+([^,]+)/i);
  return m ? `${m[1]} ${m[2]}` : null;
}

function deriveSignoff(body) {
  const tail = body.split('\n').slice(-6).join('\n');
  const m = tail.match(/(?:^|\n)\s*(Best regards|Best|Sincerely|Thanks|Thank you|Regards|Cheers|Warmly|Sincerely yours|Respectfully|Kind regards)\b[,\s\S]{0,40}$/i);
  return m ? m[1].trim() : null;
}

function deriveFormality(bodies) {
  const contractions = bodies.reduce((sum, b) => sum + (b.match(/\b(i|you|we|they|don|can|won|isn|aren|wouldn|couldn|shouldn|is|are)\b'\w+/gi) || []).length, 0);
  const slang = bodies.reduce((sum, b) => sum + (b.match(/\b(lol|tbh|gonna|wanna|kinda|stuff|thingy|yeah|ok|okay)\b/gi) || []).length, 0);
  const formalityScore = Math.max(0, 1 - (contractions + slang * 2) / Math.max(1, bodies.length));
  if (formalityScore > 0.8) return 'formal';
  if (formalityScore > 0.5) return 'balanced';
  return 'casual';
}

function mode(arr) {
  if (!arr.length) return null;
  const counts = {};
  for (const v of arr) counts[v] = (counts[v] || 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

async function refresh() {
  if (!profileDir) return { error: 'style module not initialized' };
  const result = await outlook.listSentEmails(50);
  if (result.error) return { error: result.error };
  const profile = analyzeEmails(result.messages);
  fs.writeFileSync(profilePath(EMAIL_PROFILE), JSON.stringify(profile, null, 2));
  return { ok: true, count: profile.count || 0, profile: publicProfile(profile) };
}

function publicProfile(p) {
  if (!p) return { ready: false };
  const { exemplar_bodies, ...rest } = p;
  return rest;
}

function getProfile() {
  const p = loadProfile(EMAIL_PROFILE);
  return p ? publicProfile(p) : { ready: false };
}

function getExemplars() {
  const p = loadProfile(EMAIL_PROFILE);
  return p?.exemplar_bodies || [];
}

module.exports = { init, refresh, getProfile, getExemplars };