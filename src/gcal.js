const http = require('http');
const crypto = require('crypto');
const { app, shell } = require('electron');
const secrets = require('./secrets');
const config = require('./config');

const TOKEN_KEY = 'gcal_token';
const REDIRECT_HOST = '127.0.0.1';
let redirectPort = 8765;

function isConfigured() {
  return config.isGoogleCalendarConfigured(config);
}

function buildAuthUrl(port, state, codeVerifier) {
  const redirect = `http://${REDIRECT_HOST}:${port}/`;
  const params = new URLSearchParams({
    client_id: config.googleCalendar.clientId,
    redirect_uri: redirect,
    response_type: 'code',
    scope: config.googleCalendar.scopes.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state,
    code_challenge: codeVerifierToChallenge(codeVerifier),
    code_challenge_method: 'S256',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

function codeVerifierToChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

function randomString(len) {
  return crypto.randomBytes(len).toString('base64url').slice(0, len);
}

async function connect() {
  if (!isConfigured()) return { error: 'Google Calendar credentials not configured. See docs/credentials-needed.md.' };
  redirectPort = await findFreePort();
  const state = randomString(16);
  const codeVerifier = randomString(64);
  secrets.setSecret('gcal_pkce_verifier', codeVerifier);
  const authUrl = buildAuthUrl(redirectPort, state, codeVerifier);
  shell.openExternal(authUrl);
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://${REDIRECT_HOST}:${redirectPort}`);
      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');
      const ok = Boolean(code) && returnedState === state;
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(ok
        ? '<html><body style="font-family:sans-serif;text-align:center;padding:60px"><h2>Returning to Nus...</h2><p>You can close this tab.</p></body></html>'
        : '<html><body style="font-family:sans-serif;text-align:center;padding:60px"><h2>Auth failed</h2><p>Missing or mismatched code. Try again from Nus.</p></body></html>');
      if (!ok) {
        server.close();
        resolve({ error: 'OAuth state mismatch or no code returned.' });
        return;
      }
      try {
        const token = await exchangeCode(code, codeVerifier);
        storeToken(token);
        server.close();
        resolve({ connected: true });
      } catch (e) {
        server.close();
        resolve({ error: `Token exchange failed: ${e.message}` });
      }
    });
    server.listen(redirectPort, REDIRECT_HOST, () => {
      setTimeout(() => { try { server.close(); } catch {} resolve({ error: 'Google sign-in did not come back. If Google showed a consent-screen or redirect error, check the OAuth client is type "Desktop app" and the consent screen is published.' }); }, 180000);
    });
  });
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = require('net').createServer();
    srv.listen(0, REDIRECT_HOST, () => { const p = srv.address().port; srv.close(() => resolve(p)); });
    srv.on('error', reject);
  });
}

async function exchangeCode(code, codeVerifier) {
  const redirect = `http://${REDIRECT_HOST}:${redirectPort}/`;
  const body = new URLSearchParams({
    code,
    client_id: config.googleCalendar.clientId,
    client_secret: config.googleCalendar.clientSecret,
    redirect_uri: redirect,
    grant_type: 'authorization_code',
    code_verifier: codeVerifier,
  });
  const resp = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  const data = await resp.json();
  if (data.error) throw new Error(data.error);
  return data;
}

function getToken() {
  const raw = secrets.getSecret(TOKEN_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// Google returns expires_in (seconds). Stamp an absolute expiry at write time,
// otherwise the freshness check has nothing to compare against and the token
// looks valid forever while silently 401ing after an hour.
function stampToken(data, previous = null) {
  data.refresh_token = data.refresh_token || previous?.refresh_token || null;
  data.expires_in_ms = (Number(data.expires_in) || 3600) * 1000;
  data.expires_at = new Date(Date.now() + data.expires_in_ms).toISOString();
  return data;
}

function storeToken(data, previous = null) {
  const stamped = stampToken(data, previous);
  secrets.setSecret(TOKEN_KEY, JSON.stringify(stamped));
  return stamped;
}

async function refreshTokenIfNeeded(force = false) {
  const token = getToken();
  if (!token) return null;
  const msLeft = token.expires_at ? new Date(token.expires_at).getTime() - Date.now() : 0;
  if (!force && token.access_token && msLeft > 60000) return token;
  if (!token.refresh_token) return token.access_token && !force ? token : null;
  const body = new URLSearchParams({
    client_id: config.googleCalendar.clientId,
    client_secret: config.googleCalendar.clientSecret,
    refresh_token: token.refresh_token,
    grant_type: 'refresh_token',
  });
  const resp = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  const data = await resp.json();
  if (data.error) return null;
  return storeToken(data, token);
}

async function status() {
  if (!isConfigured()) return { configured: false, connected: false };
  const token = getToken();
  return { configured: true, connected: Boolean(token && token.access_token), email: token?.email || null };
}

async function disconnect() {
  secrets.deleteSecret(TOKEN_KEY);
  secrets.deleteSecret('gcal_pkce_verifier');
  return { connected: false };
}

async function apiCall(path, options = {}, retried = false) {
  const token = await refreshTokenIfNeeded(retried);
  if (!token) throw new Error('Google Calendar not connected.');
  const resp = await fetch(`https://www.googleapis.com/calendar/v3${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  // A stale access token should heal itself once before bothering the user.
  if (resp.status === 401) {
    if (retried) throw new Error('Google Calendar sign-in expired. Reconnect it in Settings.');
    return apiCall(path, options, true);
  }
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Google Calendar API ${resp.status}: ${String(text).slice(0, 200)}`);
  }
  return resp.json();
}

async function listEvents(daysAhead = 60) {
  if (!isConfigured()) return { error: 'not configured' };
  const now = new Date();
  const max = new Date(); max.setDate(max.getDate() + daysAhead);
  const params = new URLSearchParams({
    timeMin: now.toISOString(),
    timeMax: max.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 250,
  });
  try {
    const data = await apiCall(`/calendars/primary/events?${params}`);
    const events = (data.items || []).map((e) => ({
      title: e.summary || 'Untitled',
      due_date: e.start?.dateTime ? e.start.dateTime.slice(0, 10) : (e.start?.date || ''),
      notes: e.description || '',
      gcal_id: e.id,
      source: 'google',
    }));
    return { events };
  } catch (e) {
    return { error: e.message };
  }
}

async function createEvent({ title, due_date, notes = '', minutes = 30, courseId = null }) {
  if (!isConfigured()) return { error: 'not configured' };
  const start = due_date ? new Date(`${due_date}T09:00:00`) : new Date();
  const end = new Date(start.getTime() + minutes * 60000);
  const body = {
    summary: title,
    description: notes,
    start: { dateTime: start.toISOString() },
    end: { dateTime: end.toISOString() },
  };
  try {
    const created = await apiCall(`/calendars/primary/events`, { method: 'POST', body: JSON.stringify(body) });
    return { id: created.id, htmlLink: created.htmlLink };
  } catch (e) {
    return { error: e.message };
  }
}

module.exports = { connect, status, disconnect, listEvents, createEvent, isConfigured };