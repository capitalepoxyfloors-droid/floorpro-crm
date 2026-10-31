// CrewBoard phone notifications. This worker does not handle fetch, so it
// does not cache the app and cannot change what the live site loads.
const FP_PUSH_VERSION = 'fp-push-1';

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = {};
  }
  const title = clip(data.title || 'CrewBoard', 80);
  const body = clip(data.body || 'New message', 140);
  const url = safeOpenUrl(data.url);
  const tag = String(data.tag || 'crewboard').slice(0, 80);
  const badge = Math.max(0, Math.min(99, Number(data.badge) || 0));
  event.waitUntil((async () => {
    await self.registration.showNotification(title, {
      body,
      icon: 'icon.png',
      badge: 'icon.png',
      tag,
      renotify: true,
      data: { url },
    });
    await setBadge(badge);
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = safeOpenUrl(event.notification.data && event.notification.data.url);
  event.waitUntil(openOrFocus(url));
});

function clip(value, max) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text;
}

function safeOpenUrl(raw) {
  const fallback = new URL('./', self.registration.scope).href;
  try {
    const scope = new URL(self.registration.scope);
    const url = new URL(raw || fallback, scope.origin);
    if (url.origin !== scope.origin) return fallback;
    if (!url.pathname.startsWith(scope.pathname)) return fallback;
    return url.href;
  } catch (e) {
    return fallback;
  }
}

async function openOrFocus(url) {
  const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of all) {
    let same = false;
    try {
      same = new URL(client.url).origin === new URL(url).origin;
    } catch (e) {
      same = false;
    }
    if (!same) continue;
    if ('navigate' in client) {
      try { await client.navigate(url); } catch (e) { /* older browsers */ }
    }
    if ('focus' in client) await client.focus();
    client.postMessage({ type: 'fp-open', url });
    return;
  }
  await self.clients.openWindow(url);
}

async function setBadge(count) {
  const nav = self.navigator;
  if (!nav || typeof nav.setAppBadge !== 'function') return;
  try {
    if (count > 0) await nav.setAppBadge(count);
    else if (typeof nav.clearAppBadge === 'function') await nav.clearAppBadge();
  } catch (e) { /* badges need an installed app on some phones */ }
}

void FP_PUSH_VERSION;
