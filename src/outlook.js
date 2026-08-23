const http = require('http');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { shell, app } = require('electron');
const secrets = require('./secrets');
const config = require('./config');

const TOKEN_KEY = 'outlook_token';
const REDIRECT_HOST = '127.0.0.1';
let redirectPort = 8766;

function isConfigured() {
  return config.isOutlookConfigured(config);
}

function randomString(len) {
  return crypto.randomBytes(len).toString('base64url').slice(0, len);
}

function codeVerifierToChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

function scopesFor(withSend) {
  return withSend && config.outlook.sendScopes ? config.outlook.sendScopes : config.outlook.scopes;
}

function buildAuthUrl(port, state, codeVerifier, withSend) {
  const redirect = `http://${REDIRECT_HOST}:${port}/`;
  const params = new URLSearchParams({
    client_id: config.outlook.clientId,
    redirect_uri: redirect,
    response_type: 'code',
    scope: scopesFor(withSend).join(' '),
    state,
    code_challenge: codeVerifierToChallenge(codeVerifier),
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  return `https://login.microsoftonline.com/${config.outlook.tenant || 'common'}/oauth2/v2.0/authorize?${params.toString()}`;
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = require('net').createServer();
    srv.listen(0, REDIRECT_HOST, () => { const p = srv.address().port; srv.close(() => resolve(p)); });
    srv.on('error', reject);
  });
}

async function connect(withSend = false) {
  if (!isConfigured()) return { error: 'Outlook credentials not configured. See docs/credentials-needed.md.' };
  redirectPort = await findFreePort();
  const state = randomString(16);
  const codeVerifier = randomString(64);
  secrets.setSecret('outlook_pkce_verifier', codeVerifier);
  const authUrl = buildAuthUrl(redirectPort, state, codeVerifier, withSend);
  return new Promise((resolve) => {
    let timeout = null;
    let settled = false;
    let callbackInProgress = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      secrets.deleteSecret('outlook_pkce_verifier');
      if (server.listening) { try { server.close(); } catch {} }
      resolve(result);
    };
    const server = http.createServer(async (req, res) => {
      if (settled || callbackInProgress) { res.writeHead(204); res.end(); return; }
      const url = new URL(req.url, `http://${REDIRECT_HOST}:${redirectPort}`);
      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');
      const authError = url.searchParams.get('error');
      const authErrorDesc = url.searchParams.get('error_description') || '';
      res.writeHead(200, { 'Content-Type': 'text/html' });
      // Universities commonly require an IT admin to approve mail access, so
      // that specific refusal gets its own message rather than a generic failure.
      if (authError) {
        const needsAdmin = /AADSTS65001|AADSTS90094|consent|admin/i.test(authErrorDesc + authError);
        res.end('<html><body style="font-family:sans-serif;text-align:center;padding:60px"><h2>Not connected</h2><p>You can close this tab and return to Nus.</p></body></html>');
        finish({
          error: needsAdmin
            ? 'Your school requires IT approval before an app can access your mail. The email drafter still works without connecting, or connect a personal Microsoft account instead.'
            : `Outlook sign-in was refused: ${authErrorDesc.slice(0, 180) || authError}`,
          needsAdminConsent: needsAdmin,
        });
        return;
      }
      if (!code || returnedState !== state) {
        res.end('<html><body><h2>Auth failed</h2><p>State mismatch. Try again.</p></body></html>');
        finish({ error: 'OAuth state mismatch or no code returned.' });
        return;
      }
      callbackInProgress = true;
      res.end('<html><body style="font-family:sans-serif;text-align:center;padding:60px"><h2>Returning to Nus...</h2><p>You can close this tab.</p></body></html>');
      try {
        const token = await exchangeCode(code, codeVerifier, withSend);
        secrets.setSecret(TOKEN_KEY, JSON.stringify(token));
        const me = await graphGet('/me', token.access_token);
        if (me && me.mail) token.email = me.mail || me.userPrincipalName;
        secrets.setSecret(TOKEN_KEY, JSON.stringify(token));
        finish({ connected: true, email: token.email || null });
      } catch (e) {
        finish({ error: `Outlook token exchange failed: ${e.message}` });
      }
    });
    server.on('error', (error) => finish({ error: `Could not start the Outlook sign-in callback: ${error.message}` }));
    server.listen(redirectPort, REDIRECT_HOST, async () => {
      try { await shell.openExternal(authUrl); }
      catch (error) { finish({ error: `Could not open Outlook sign-in: ${error.message}` }); return; }
      timeout = setTimeout(() => finish({ error: 'Outlook sign-in did not come back. If the browser showed AADSTS900971, the Azure app needs redirect URI http://127.0.0.1 under "Mobile and desktop applications".' }), 180000);
    });
  });
}

async function exchangeCode(code, codeVerifier, withSend = false) {
  const redirect = `http://${REDIRECT_HOST}:${redirectPort}/`;
  const body = new URLSearchParams({
    code,
    client_id: config.outlook.clientId,
    redirect_uri: redirect,
    grant_type: 'authorization_code',
    code_verifier: codeVerifier,
    scope: scopesFor(withSend).join(' '),
  });
  const resp = await fetch(`https://login.microsoftonline.com/${config.outlook.tenant || 'common'}/oauth2/v2.0/token`, {
    method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  const data = await resp.json();
  if (data.error) throw new Error(data.error_description || data.error);
  data.expires_in_ms = (data.expires_in || 3600) * 1000;
  data.expires_at = new Date(Date.now() + data.expires_in_ms).toISOString();
  return data;
}

function getToken() {
  const raw = secrets.getSecret(TOKEN_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function refreshTokenIfNeeded(force = false) {
  const token = getToken();
  if (!token) return null;
  const msLeft = token.expires_at ? new Date(token.expires_at).getTime() - Date.now() : 0;
  if (!force && token.access_token && msLeft > 60000) return token;
  if (!token.refresh_token) return token.access_token && !force ? token : null;
  const body = new URLSearchParams({
    client_id: config.outlook.clientId,
    refresh_token: token.refresh_token,
    grant_type: 'refresh_token',
    scope: (token.scope || config.outlook.scopes.join(' ')),
  });
  const resp = await fetch(`https://login.microsoftonline.com/${config.outlook.tenant || 'common'}/oauth2/v2.0/token`, {
    method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  const data = await resp.json();
  if (data.error) return null;
  data.refresh_token = data.refresh_token || token.refresh_token;
  data.expires_in_ms = (data.expires_in || 3600) * 1000;
  data.expires_at = new Date(Date.now() + data.expires_in_ms).toISOString();
  data.email = token.email;
  secrets.setSecret(TOKEN_KEY, JSON.stringify(data));
  return data;
}

async function status() {
  if (!isConfigured()) return { configured: false, connected: false };
  const token = getToken();
  return { configured: true, connected: Boolean(token && token.access_token), email: token?.email || null };
}

async function disconnect() {
  secrets.deleteSecret(TOKEN_KEY);
  secrets.deleteSecret('outlook_pkce_verifier');
  return { connected: false };
}

async function graphGet(path, accessToken, retried = false) {
  const token = (retried ? null : accessToken) || (await refreshTokenIfNeeded(retried))?.access_token;
  if (!token) throw new Error('Outlook not connected.');
  const resp = await fetch(`https://graph.microsoft.com/v1.0${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (resp.status === 401 && !retried) return graphGet(path, null, true);
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Graph ${resp.status}: ${String(text).slice(0, 200)}`);
  }
  return resp.json();
}

async function graphPost(path, body, accessToken, retried = false) {
  const token = (retried ? null : accessToken) || (await refreshTokenIfNeeded(retried))?.access_token;
  if (!token) throw new Error('Outlook not connected.');
  const resp = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (resp.status === 401 && !retried) return graphPost(path, body, null, true);
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Graph ${resp.status}: ${String(text).slice(0, 200)}`);
  }
  const text = await resp.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return {}; }
}

async function listSentEmails(count = 50) {
  const token = await refreshTokenIfNeeded();
  if (!token) return { error: 'Outlook not connected.' };
  const params = new URLSearchParams({
    $top: String(count),
    $select: 'subject,body,from,sentDateTime',
    $orderby: 'sentDateTime desc',
    $filter: "from/emailAddress/address eq '" + (token.email || '') + "'",
  });
  try {
    const data = await graphGet(`/me/mailFolders/SentItems/messages?${params}`, token.access_token);
    return { messages: data.value || [] };
  } catch (e) {
    return { error: e.message };
  }
}

async function listInbox(count = 5) {
  const token = await refreshTokenIfNeeded();
  if (!token) return { error: 'Outlook not connected.' };
  const params = new URLSearchParams({
    $top: String(count),
    $select: 'subject,from,receivedDateTime,bodyPreview,isRead,importance',
    $orderby: 'receivedDateTime desc',
  });
  try {
    const data = await graphGet(`/me/mailFolders/Inbox/messages?${params}`, token.access_token);
    return {
      messages: (data.value || []).map((m) => ({
        subject: m.subject || '(no subject)',
        from_name: m.from?.emailAddress?.name || m.from?.emailAddress?.address || 'Unknown sender',
        from_address: m.from?.emailAddress?.address || '',
        received_at: m.receivedDateTime,
        preview: String(m.bodyPreview || '').slice(0, 160),
        unread: m.isRead === false,
        important: m.importance === 'high',
      })),
    };
  } catch (e) {
    return { error: e.message };
  }
}

async function sendMail({ to, subject, body }) {
  const token = await refreshTokenIfNeeded();
  if (!token) return { error: 'Outlook not connected.' };
  if (token.scope && !/Mail\.Send/i.test(token.scope)) {
    return { error: 'This connection is read-only. Use Copy and paste the draft into Outlook, or reconnect with sending enabled.', needsSendScope: true };
  }
  const message = {
    message: {
      subject,
      body: { contentType: 'Text', content: body },
      toRecipients: [{ emailAddress: { address: to } }],
    },
    saveToSentItems: true,
  };
  try {
    await graphPost('/me/sendMail', message, token.access_token);
    return { ok: true };
  } catch (e) {
    return { error: e.message };
  }
}

module.exports = { connect, status, disconnect, listSentEmails, listInbox, sendMail, isConfigured };
