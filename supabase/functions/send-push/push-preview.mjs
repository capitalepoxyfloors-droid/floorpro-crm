// Notification text for a phone lock screen.
// Sender name and the first line of the message only. Dollar amounts, phone
// numbers, and long digit runs are removed so a preview cannot show pay or a
// private number. The in-app thread is unchanged.

const PREVIEW_KEYS = ['title', 'body', 'url', 'tag', 'badge'];

export function pushPreview(label, body) {
  const title = clip(oneLine(label) || 'Someone', 80);
  let line = oneLine(String(body == null ? '' : body).split(/\r?\n/)[0]);
  line = line.replace(/\$\s?\d[\d,]*(?:\.\d{1,2})?/g, '');
  line = line.replace(/(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]\d{4}/g, '');
  line = line.replace(/\b\d{3}[-.\s]\d{4}\b/g, '');
  line = line.replace(/\b\d{9,}\b/g, '');
  line = oneLine(line);
  if (!line) line = 'New message';
  return { title, body: clip(line, 140) };
}

export function pushOpenUrl(pageOrigin, target) {
  const origin = pageOrigin || 'https://capitalepoxyfloors-droid.github.io';
  const url = new URL('/floorpro-crm/', origin);
  url.searchParams.set('env', 'test');
  const open = target && target.open;
  if (open !== 'dm' && open !== 'job' && open !== 'team') return url.href;
  url.searchParams.set('open', open);
  if (open === 'job' && target.job) url.searchParams.set('job', String(target.job).slice(0, 80));
  if (open === 'dm' && target.peer) url.searchParams.set('peer', String(target.peer).slice(0, 80));
  return url.href;
}

export function notificationPayload(target, pageOrigin) {
  const preview = pushPreview(target && target.title, target && target.body);
  const badge = Math.max(0, Math.min(99, Number(target && target.badge) || 0));
  const tag = String((target && target.tag) || 'crewboard').replace(/[^\w:.-]/g, '').slice(0, 80) || 'crewboard';
  return {
    title: preview.title,
    body: preview.body,
    url: pushOpenUrl(pageOrigin, target),
    tag,
    badge,
  };
}

export function payloadKeys() {
  return PREVIEW_KEYS.slice();
}

export function classifyPushStatus(status) {
  const code = Number(status) || 0;
  if (code === 410 || code === 404) return 'gone';
  if (code >= 200 && code < 300) return 'sent';
  return 'failed';
}

function oneLine(value) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
}

function clip(value, max) {
  const text = String(value || '');
  return text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text;
}
