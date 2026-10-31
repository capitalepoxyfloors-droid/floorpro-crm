// Sends a Web Push when a direct message or job message is inserted.
// The database trigger posts only { table, id } plus a shared secret.
// This function is deployed on the test project only. It refuses any other
// project, including live (cngbsmmdfxmerlqnkate).
//
// verify_jwt is off. The caller is the database, not a signed-in person.
// The shared secret in x-push-secret is checked against vault.

import { createClient } from 'npm:@supabase/supabase-js@2';
import webpushPkg from 'npm:web-push@3.6.7';
import {
  classifyPushStatus,
  notificationPayload,
} from './push-preview.mjs';

// The web-push package is CommonJS. Deno exposes that as the default export.
const webpush = ((webpushPkg as { default?: typeof webpushPkg }).default ?? webpushPkg) as {
  setVapidDetails: (subject: string, publicKey: string, privateKey: string) => void;
  sendNotification: (sub: { endpoint: string; keys: { p256dh: string; auth: string } }, payload: string, opts: { TTL: number; urgency: string }) => Promise<unknown>;
};

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-push-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function envKeys() {
  const url = Deno.env.get('SUPABASE_URL') ?? '';
  const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    ?? Deno.env.get('SUPABASE_SECRET_KEY')
    ?? '';
  return { url, service };
}

const TEST_REF = 'nndjnywtkgxwvxajwztg';
const LIVE_REF = 'cngbsmmdfxmerlqnkate';
const PAGE_ORIGIN = 'https://capitalepoxyfloors-droid.github.io';
const VAPID_SUBJECT = 'mailto:capitalepoxyfloors@gmail.com';

type SubRow = { id?: string; endpoint?: string; p256dh?: string; auth_key?: string };
type Target = {
  title?: string;
  body?: string;
  open?: string;
  job?: string | null;
  peer?: string | null;
  tag?: string;
  badge?: number;
  subscriptions?: SubRow[];
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const { url, service } = envKeys();
  if (!url || !service) return json({ error: 'Push is not configured.' }, 503);
  if (url.includes(LIVE_REF) || !url.includes(TEST_REF)) {
    return json({ error: 'Push is only turned on for the test project.' }, 403);
  }

  let body: { table?: string; id?: string } = {};
  try {
    const text = await req.text();
    if (text.length > 2000) return json({ error: 'Bad request' }, 400);
    body = text ? JSON.parse(text) : {};
  } catch {
    return json({ error: 'Bad request' }, 400);
  }
  const table = String(body.table || '');
  const id = String(body.id || '');
  if (table !== 'direct_messages' && table !== 'job_messages') return json({ error: 'Bad request' }, 400);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return json({ error: 'Bad request' }, 400);
  }

  const provided = req.headers.get('x-push-secret') || '';
  const cfg = await loadConfig(url, service);
  if (!cfg.webhookSecret || !sameSecret(provided, cfg.webhookSecret)) {
    return json({ error: 'Not allowed' }, 401);
  }
  if (!cfg.publicKey || !cfg.privateKey) return json({ error: 'Push is not configured.' }, 503);

  const db = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
  const plan = await db.rpc('fp_push_plan', { p_table: table, p_id: id });
  if (plan.error) {
    console.error('push plan failed', plan.error.code || plan.error.message);
    return json({ error: 'Could not build the notification.' }, 500);
  }
  let planned: unknown = plan.data;
  if (typeof planned === 'string') {
    try { planned = JSON.parse(planned); } catch { planned = []; }
  }
  const targets = Array.isArray(planned) ? planned as Target[] : [];
  webpush.setVapidDetails(VAPID_SUBJECT, cfg.publicKey, cfg.privateKey);

  let sent = 0;
  let failed = 0;
  const gone: string[] = [];
  for (const target of targets) {
    const payload = JSON.stringify(notificationPayload(target, PAGE_ORIGIN));
    if (payload.length > 3500) continue;
    for (const sub of target.subscriptions || []) {
      if (!sub.endpoint || !sub.p256dh || !sub.auth_key || !/^https:\/\//i.test(sub.endpoint)) continue;
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth_key } },
          payload,
          { TTL: 60 * 60, urgency: 'high' },
        );
        sent += 1;
      } catch (err) {
        const status = Number((err as { statusCode?: number }).statusCode || 0);
        if (classifyPushStatus(status) === 'gone' && sub.id) gone.push(sub.id);
        else failed += 1;
      }
    }
  }

  if (gone.length) {
    const removed = await db.from('push_subscriptions').delete().in('id', gone);
    if (removed.error) console.error('push cleanup failed', removed.error.code || removed.error.message);
  }

  return json({ ok: true, sent, failed, removed: gone.length });
});

async function loadConfig(url: string, service: string) {
  const fromEnv = {
    publicKey: Deno.env.get('VAPID_PUBLIC_KEY') || '',
    privateKey: Deno.env.get('VAPID_PRIVATE_KEY') || '',
    webhookSecret: Deno.env.get('PUSH_WEBHOOK_SECRET') || '',
  };
  if (fromEnv.publicKey && fromEnv.privateKey && fromEnv.webhookSecret) return fromEnv;

  const db = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
  const rpc = await db.rpc('fp_push_runtime_config');
  const data = (rpc.data || {}) as { public_key?: string; private_key?: string; webhook_secret?: string };
  return {
    publicKey: fromEnv.publicKey || data.public_key || '',
    privateKey: fromEnv.privateKey || data.private_key || '',
    webhookSecret: fromEnv.webhookSecret || data.webhook_secret || '',
  };
}

function sameSecret(a: string, b: string) {
  const enc = new TextEncoder();
  const left = enc.encode(a);
  const right = enc.encode(b);
  if (left.length !== right.length || left.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}
