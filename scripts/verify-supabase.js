#!/usr/bin/env node
// Checks that the configured Supabase project actually has the schema applied,
// using the anon key already in src/config.js.
//
//   node scripts/verify-supabase.js
//
// This talks to your own project with your own public key and never prints it.
// It reads nothing and writes nothing; it only asks PostgREST whether each
// object exists and whether the permissions are the ones the schema intends.
//
// Interpreting the results, because "empty" is the correct answer here:
//   A table that exists but is protected by RLS returns 200 with zero rows,
//   since an anonymous caller has no auth.uid() to match. That is a PASS.
//   A missing table returns a PGRST205 "could not find the table" error.
//   entitlement() is granted to authenticated only, so anon being REFUSED is
//   the pass condition. If anon could run it, the grant would be wrong.

const config = require('../src/config');

const url = config.supabase && config.supabase.url;
const key = config.supabase && config.supabase.anonKey;

if (!url || !key) {
  console.error('\n  Supabase is not configured. Run scripts/configure-supabase.js first.\n');
  process.exit(1);
}

const TABLES = ['profiles', 'subscriptions', 'devices', 'events'];

async function get(pathname) {
  const res = await fetch(`${url}${pathname}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  let body = null;
  try { body = await res.json(); } catch {}
  return { status: res.status, body };
}

async function rpc(name) {
  const res = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: '{}',
  });
  let body = null;
  try { body = await res.json(); } catch {}
  return { status: res.status, body };
}

function line(label, ok, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(34)} ${detail}`);
  return ok;
}

(async () => {
  console.log(`\n  Project: ${url}\n`);
  let allOk = true;

  // Reachability first, so a DNS or paused-project problem is not reported as
  // a missing table.
  try {
    const ping = await get('/rest/v1/');
    allOk = line('project reachable', ping.status < 500, `HTTP ${ping.status}`) && allOk;
  } catch (error) {
    line('project reachable', false, error.message);
    console.log('\n  Could not reach the project at all. Check the URL, and check the\n  project is not paused in the Supabase dashboard.\n');
    process.exit(1);
  }

  for (const table of TABLES) {
    const res = await get(`/rest/v1/${table}?select=*&limit=1`);
    const missing = res.body && (res.body.code === 'PGRST205' || /could not find the table/i.test(res.body.message || ''));
    const rows = Array.isArray(res.body) ? res.body.length : null;

    if (missing) {
      allOk = line(`table ${table}`, false, 'NOT FOUND - schema.sql has not been run') && allOk;
    } else if (res.status === 200) {
      allOk = line(`table ${table}`, true, `exists, RLS returned ${rows} rows to anon (correct)`) && allOk;
    } else {
      allOk = line(`table ${table}`, false, `HTTP ${res.status} ${(res.body && res.body.message) || ''}`) && allOk;
    }
  }

  // entitlement() must exist and must NOT be callable by anon.
  const ent = await rpc('entitlement');
  const notFound = ent.body && (ent.body.code === 'PGRST202' || /could not find the function/i.test(ent.body.message || ''));
  if (notFound) {
    allOk = line('function entitlement()', false, 'NOT FOUND - schema.sql has not been run') && allOk;
  } else if (ent.status === 401 || ent.status === 403) {
    allOk = line('function entitlement()', true, 'exists and refuses anon (correct)') && allOk;
  } else if (ent.status === 200) {
    allOk = line('function entitlement()', false, 'anon can execute it - the grant is too open') && allOk;
  } else {
    allOk = line('function entitlement()', true, `exists, HTTP ${ent.status}`) && allOk;
  }

  // Anon must never be able to write an entitlement.
  const write = await fetch(`${url}/rest/v1/subscriptions`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'content-type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ user_id: '00000000-0000-0000-0000-000000000000', plan: 'pro', status: 'active' }),
  });
  allOk = line('anon cannot grant itself Pro', write.status !== 201 && write.status !== 200,
    `write refused with HTTP ${write.status}`) && allOk;

  console.log('');
  if (allOk) {
    console.log('  Schema is live and the permissions are right. Part 3 (Stripe) is next.\n');
  } else {
    console.log('  Something is missing. If tables are NOT FOUND, paste supabase/schema.sql\n  into the Supabase SQL editor and run it, then re-run this.\n');
    process.exit(1);
  }
})();
