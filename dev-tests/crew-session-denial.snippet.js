// Run this inside an already signed-in floorpro-crm-test tab.
// It calls the page's own sb.rpc and writes only allow/deny lines.
// It does not read, print, or copy a PIN, token, or hash.
// Repeat it in this tab while the test sign-in is still open.
(async function () {
  const box = document.createElement('div');
  box.id = 'fp-denial-check';
  box.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:999999;background:#111;color:#fff;padding:12px 14px;max-width:560px;font:13px/1.45 ui-monospace,monospace;white-space:pre-wrap;';
  document.body.appendChild(box);
  const url = typeof SUPABASE_URL === 'string' ? SUPABASE_URL : '';
  const testHost = url.indexOf('nndjnywtkgxwvxajwztg') !== -1 && url.indexOf('cngbsmmdfxmerlqnkate') === -1;
  const lines = ['target=' + (testHost ? 'floorpro-crm-test' : 'REFUSED')];
  if (!testHost) { box.textContent = lines.join('\n'); return; }
  let role = '';
  try { role = localStorage.getItem('fpRole') || ''; } catch (e) { role = ''; }
  lines.push('role=' + (role === 'crew' ? 'crew' : (role ? 'other' : 'blank')));
  async function one(name, args) {
    const r = await sb.rpc(name, args);
    let msg = '';
    try { msg = String((r && r.error && (r.error.message || r.error.code)) || ''); } catch (e) { msg = ''; }
    msg = msg.replace(/eyJ[A-Za-z0-9_\-.]+/g, '').slice(0, 60);
    lines.push(name + ' ' + (r && r.ok ? 'ALLOWED' : 'denied') + ' ' + ((r && r.status) || '') + ' ' + msg);
  }
  const nil = '00000000-0000-0000-0000-000000000000';
  await one('fp_issues_open_unassigned', {});
  await one('fp_document_history', { p_document: nil });
  await one('fp_document_access_history', { p_document: nil });
  await one('fp_document_create', { p_job: 'not-a-real-job', p_title: 'QA must not create', p_key: '00000000-0000-0000-0000-000000000001' });
  await one('fp_document_promote', { p_document: nil, p_revision: '00000000-0000-0000-0000-000000000001', p_expected: null });
  await one('fp_issue_update', { p_issue: nil, p_status: 'resolved', p_owner: null, p_due: null });
  await one('fp_stop_order_set', { p_idx: 999999, p_date: '2026-11-08', p_ids: [], p_expected: 0 });
  await one('fp_stop_order_read', { p_idx: 999999, p_date: '2026-11-08' });
  let host = document.getElementById('fp-open-issues');
  let made = false;
  if (!host) {
    host = document.createElement('div');
    host.id = 'fp-open-issues';
    document.body.appendChild(host);
    made = true;
  }
  if (typeof _fpLoadOpenIssues === 'function') await _fpLoadOpenIssues();
  lines.push('app-office-list=' + (host.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40));
  if (made) host.remove();
  box.textContent = lines.join('\n');
})();
