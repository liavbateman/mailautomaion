(() => {
  'use strict';

  const { KEYS, builtinGroups, loadBuiltin, VAR_RE, VAR_FORMATS, storage, isImageVar, orderVars, analyze, applyDarkMode, escapeHtml } = globalThis.GHX;

  const MKEYS = {
    clientId: 'ghxOAuthClientId',
    account: 'ghxAccount',
    sentLog: 'ghxSentLog',
    suppress: 'ghxSuppress',
    mergePrefs: 'ghxMergePrefs',
  };
  const SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
  const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';
  const SCOPES = 'https://www.googleapis.com/auth/gmail.send openid email';
  const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]{2,}$/;
  const MAX_CONSECUTIVE_FAILURES = 5;

  // Column headers that mean "the organization's name", compared after normalize()
  const ORG_HEADERS = ['שםהארגון', 'ארגון', 'מתנס', 'שםהמתנס', 'מרכזקהילתי', 'שםהמרכז', 'שםהמרכזהקהילתי', 'מוסד', 'שםהמוסד', 'שם'];
  const EMAIL_HEADERS = /mail|מייל|דואל|דואראלקטרוני|אימייל/i;

  const STATUS = {
    ready: { text: 'ממתין', cls: 'ready' },
    sending: { text: 'נשלח…', cls: 'sending' },
    sent: { text: 'נשלח ✓', cls: 'sent' },
    failed: { text: 'נכשל', cls: 'failed' },
    invalid: { text: 'מייל לא תקין', cls: 'skip' },
    duplicate: { text: 'כפול ברשימה', cls: 'skip' },
    suppressed: { text: 'ברשימת הסרה', cls: 'skip' },
    already: { text: 'כבר קיבל בקמפיין הזה', cls: 'skip' },
    previous: { text: 'קיבל מייל בקמפיין קודם', cls: 'skip' },
    missing: { text: 'חסר', cls: 'skip' },
  };

  const $ = (s) => document.querySelector(s);
  const normalize = (s) => String(s).replace(/["'״׳`\s\-_.:]/g, '').toLowerCase();

  const state = {
    source: '',
    base: null, // analyze() of the template without row data: variable names and defaults
    values: {}, // variable values saved from the editor
    font: 'tahoma',
    workbook: null,
    headers: [],
    data: [], // spreadsheet rows as {header: cell}
    emailCol: '',
    mapping: {}, // variable name → column header, or '' for the fixed value
    rows: [], // {index, email, values, status, reason}
    current: 0,
    running: false,
    token: null,
    tokenExpires: 0,
    account: '',
    clientId: '',
    sentLog: {},
    suppress: new Set(),
    prefs: { device: 'desktop', theme: 'light' },
    subjectEdited: false,
    ab: { enabled: false, source: '', base: null },
  };

  // ---------- Template ----------

  async function loadSourceList() {
    const data = await storage.get([KEYS.draft, KEYS.templates, KEYS.vars, KEYS.prefs]);
    state.values = data[KEYS.vars] || {};
    state.font = (data[KEYS.prefs] || {}).font ?? 'tahoma';
    for (const select of [$('#source'), $('#source-b')]) {
      select.innerHTML = '';
      if ((data[KEYS.draft] || '').trim()) select.appendChild(new Option('התבנית הפתוחה בעורך', 'draft'));
      for (const g of builtinGroups()) {
        const group = document.createElement('optgroup');
        group.label = g.label;
        g.templates.forEach((t) => group.appendChild(new Option(t.name, `b:${t.id}`)));
        select.appendChild(group);
      }
      Object.keys(data[KEYS.templates] || {}).forEach((n) => select.appendChild(new Option(`★ ${n}`, `s:${n}`)));
    }
    $('#source').onchange = () => loadSource($('#source').value);
    $('#source-b').onchange = () => loadSourceB($('#source-b').value);
    // Default B to one of the user's saved templates (where a B version would live);
    // otherwise the same as A, never a generic built-in they didn't pick
    const saved = [...$('#source-b').options].find((o) => o.value.startsWith('s:'));
    $('#source-b').value = saved ? saved.value : $('#source').value;
    await loadSourceB($('#source-b').value, { quiet: true });
    await loadSource($('#source').value);
  }

  async function fetchSource(value) {
    const data = await storage.get([KEYS.draft, KEYS.templates]);
    if (value === 'draft') return data[KEYS.draft] || '';
    if (value.startsWith('b:')) return (await loadBuiltin(value.slice(2))) || '';
    return (data[KEYS.templates] || {})[value.slice(2)] || '';
  }

  async function loadSourceB(value, { quiet = false } = {}) {
    state.ab.source = await fetchSource(value);
    state.ab.base = analyze(state.ab.source, {}, state.font);
    if (quiet) return;
    renderTemplateWarnings();
    buildRows();
  }

  async function loadSource(value) {
    state.source = await fetchSource(value);
    state.base = analyze(state.source, {}, state.font);
    renderTemplateWarnings();
    if (!state.subjectEdited) $('#subject').value = state.base.title;
    if (!$('#campaign').dataset.edited) $('#campaign').value = $('#subject').value;
    autoMap();
    renderMapping();
    buildRows();
  }

  // ---------- A/B ----------

  const abOn = () => state.ab.enabled && !!state.ab.source;
  const sourceFor = (variant) => (variant === 'B' && abOn() ? state.ab.source : state.source);
  const baseFor = (variant) => (variant === 'B' && abOn() ? state.ab.base : state.base);
  // Variables of both versions, so the column mapping covers everything that will be sent
  const allVarNames = () => orderVars([...new Set([...state.base.varNames, ...(abOn() ? state.ab.base.varNames : [])])]);
  const defaultOf = (name) => state.base.varDefaults[name] || (abOn() && state.ab.base.varDefaults[name]) || '';
  const subjectFor = (variant) =>
    (variant === 'B' && abOn() && $('#subject-b').value.trim()) || $('#subject').value;

  // Problems that would reach every recipient (broken image links, base64 images, clipping)
  function templateProblems(variant = 'A') {
    const withValues = analyze(sourceFor(variant), state.values, state.font);
    return withValues.warnings.filter((w) => w.level === 'error');
  }

  function allTemplateProblems() {
    const a = templateProblems('A');
    const b = abOn() ? templateProblems('B').map((w) => ({ ...w, text: `גרסה B: ${w.text}` })) : [];
    return [...a, ...b];
  }

  function renderTemplateWarnings() {
    const fill = (box, problems) => {
      box.innerHTML = '';
      for (const w of problems) {
        const div = document.createElement('div');
        div.className = 'message err';
        div.textContent = `⛔ ${w.text}`;
        box.appendChild(div);
      }
    };
    fill($('#template-warnings'), templateProblems('A'));
    fill($('#template-warnings-b'), abOn() ? templateProblems('B') : []);
  }

  // Row data wins over the editor's saved values; unmapped variables use the saved value
  // or the template's default.
  function rowValues(cells) {
    const values = { ...state.values };
    for (const [name, col] of Object.entries(state.mapping)) {
      if (col) values[name] = String(cells[col] ?? '').trim();
    }
    return values;
  }

  function fillText(text, values, base = state.base) {
    return text.replace(VAR_RE, (whole, name, format) => {
      const v = (values[name] || '').trim() || (base.varDefaults[name] || '');
      if (!v) return '';
      return VAR_FORMATS[format] ? VAR_FORMATS[format](v) : v;
    });
  }

  // ---------- Spreadsheet ----------

  async function readFile(file) {
    const buf = await file.arrayBuffer();
    state.workbook = XLSX.read(buf, { type: 'array' });
    const names = state.workbook.SheetNames;
    const sheetSelect = $('#sheet');
    sheetSelect.innerHTML = '';
    names.forEach((n) => sheetSelect.appendChild(new Option(n, n)));
    $('#sheet-row').hidden = names.length < 2;
    const first = names.find((n) => XLSX.utils.sheet_to_json(state.workbook.Sheets[n], { header: 1 }).length > 1) || names[0];
    sheetSelect.value = first;
    readSheet(first);
  }

  function readSheet(name) {
    const aoa = XLSX.utils.sheet_to_json(state.workbook.Sheets[name], { header: 1, defval: '', raw: false, blankrows: false });
    const headerIndex = aoa.findIndex((r) => r.filter((c) => String(c).trim()).length >= 1);
    const headers = (aoa[headerIndex] || []).map((h, i) => String(h).trim() || `עמודה ${i + 1}`);
    state.headers = headers;
    state.data = aoa
      .slice(headerIndex + 1)
      .filter((r) => r.some((c) => String(c).trim()))
      .map((r) => Object.fromEntries(headers.map((h, i) => [h, String(r[i] ?? '').trim()])));
    state.emailCol = '';
    state.mapping = {};
    autoMap();
    renderMapping();
    buildRows();
    state.current = state.rows.findIndex((r) => r.status === 'ready');
    if (state.current < 0) state.current = 0;
    renderPreview();
  }

  function autoMap() {
    if (!state.headers.length || !state.base) return;
    if (!state.emailCol) {
      state.emailCol =
        state.headers.find((h) => EMAIL_HEADERS.test(normalize(h))) ||
        state.headers.find((h) => state.data.filter((r) => EMAIL_RE.test(r[h])).length > state.data.length / 2) ||
        '';
    }
    for (const name of allVarNames()) {
      if (isImageVar(name) || name in state.mapping) continue;
      const n = normalize(name);
      let col = state.headers.find((h) => normalize(h) === n);
      if (!col && n === 'שםהארגון') col = state.headers.find((h) => ORG_HEADERS.includes(normalize(h)));
      state.mapping[name] = col || '';
    }
  }

  function renderMapping() {
    $('#mapping').hidden = !state.headers.length;
    if (!state.headers.length) return;

    const emailSelect = $('#email-col');
    emailSelect.innerHTML = '';
    emailSelect.appendChild(new Option('— בחרו עמודה —', ''));
    state.headers.forEach((h) => emailSelect.appendChild(new Option(h, h)));
    emailSelect.value = state.emailCol;
    emailSelect.onchange = () => {
      state.emailCol = emailSelect.value;
      buildRows();
    };

    const box = $('#var-map');
    box.innerHTML = '';
    for (const name of allVarNames().filter((n) => !isImageVar(n))) {
      const row = document.createElement('div');
      row.className = 'map-row';
      const label = document.createElement('label');
      label.textContent = name;
      const select = document.createElement('select');
      select.appendChild(new Option('ערך קבוע לכולם', ''));
      state.headers.forEach((h) => select.appendChild(new Option(`עמודה: ${h}`, h)));
      select.value = state.mapping[name] || '';
      const fixed = document.createElement('input');
      fixed.type = 'text';
      fixed.value = state.values[name] || '';
      fixed.placeholder = defaultOf(name) || 'ערך';
      // A variable the template has no default for (like the organization's name) usually
      // differs per recipient, so a fixed value is likely a mistake worth pointing out.
      const note = document.createElement('span');
      note.className = 'muted';
      note.textContent = '⚠ אותו ערך לכל הנמענים';
      const sync = () => {
        fixed.hidden = !!select.value;
        note.hidden = !!select.value || !!defaultOf(name);
      };
      sync();
      select.onchange = () => {
        state.mapping[name] = select.value;
        sync();
        buildRows();
      };
      fixed.oninput = () => {
        state.values[name] = fixed.value;
        storage.set({ [KEYS.vars]: state.values });
        buildRows();
      };
      row.append(label, select, fixed, note);
      box.appendChild(row);
    }
  }

  function campaignKey(email) {
    return `${$('#campaign').value.trim()}|${email.toLowerCase()}`;
  }

  // Every campaign each address has received, newest first: email → [{campaign, at}]
  function sendHistory() {
    const byEmail = new Map();
    for (const [key, at] of Object.entries(state.sentLog)) {
      const cut = key.lastIndexOf('|');
      const email = key.slice(cut + 1);
      if (!byEmail.has(email)) byEmail.set(email, []);
      byEmail.get(email).push({ campaign: key.slice(0, cut), at });
    }
    for (const list of byEmail.values()) list.sort((a, b) => b.at.localeCompare(a.at));
    return byEmail;
  }

  const formatDate = (iso) =>
    new Date(iso).toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: '2-digit' });

  function historyLabel(history) {
    if (!history.length) return '';
    const [last] = history;
    return `✓ ${formatDate(last.at)}${history.length > 1 ? ` (+${history.length - 1})` : ''}`;
  }

  const historyTitle = (history) => history.map((h) => `${formatDate(h.at)} · ${h.campaign}`).join('\n');

  function buildRows() {
    if (!state.base) return;
    const seen = new Set();
    const previous = new Map(state.rows.map((r) => [r.index, r]));
    const historyByEmail = sendHistory();
    const skipPrevious = $('#skip-previous').checked;
    let alternate = 0;
    state.rows = state.data.map((cells, index) => {
      const email = String(cells[state.emailCol] ?? '').trim();
      const values = rowValues(cells);
      const key = email.toLowerCase();
      const history = historyByEmail.get(key) || [];
      const old = previous.get(index);
      const done = old && (old.status === 'sent' || old.status === 'failed') && old.email === email;
      // Alternate A/B over the list in order; a row that already went out keeps its version
      let variant = abOn() ? '' : 'A'; // rows that won't be sent get no version
      if (done) variant = old.variant;
      else if (abOn() && EMAIL_RE.test(email) && !seen.has(key)) variant = alternate++ % 2 ? 'B' : 'A';
      const base = baseFor(variant);
      let status = 'ready';
      let reason = '';
      if (done) {
        status = old.status;
        reason = old.reason;
      } else if (!EMAIL_RE.test(email)) status = 'invalid';
      else if (seen.has(key)) status = 'duplicate';
      else if (state.suppress.has(key)) status = 'suppressed';
      else if (state.sentLog[campaignKey(email)]) status = 'already';
      else if (skipPrevious && history.length) {
        status = 'previous';
        reason = history[0].campaign;
      } else {
        const missing = base.varNames.filter((n) => !(values[n] || '').trim() && !base.varDefaults[n]);
        if (missing.length) {
          status = 'missing';
          reason = missing.join(', ');
        }
      }
      if (EMAIL_RE.test(email)) seen.add(key);
      return { index, email, cells, values, status, reason, history, variant };
    });
    renderSummary();
    renderLog();
    renderPreview();
  }

  function renderSummary() {
    const box = $('#list-summary');
    box.hidden = !state.rows.length;
    const count = (s) => state.rows.filter((r) => r.status === s).length;
    const withHistory = state.rows.filter((r) => r.history.length).length;
    const chips = [
      ['ok', `${count('ready')} ממתינים לשליחה`],
      ['ok', count('sent') && `${count('sent')} נשלחו`],
      ['err', count('failed') && `${count('failed')} נכשלו`],
      ['warn', count('invalid') && `${count('invalid')} מיילים לא תקינים`],
      ['warn', count('duplicate') && `${count('duplicate')} כפולים`],
      ['warn', count('missing') && `${count('missing')} חסרים נתונים`],
      ['warn', count('already') && `${count('already')} כבר קיבלו`],
      ['warn', count('previous') && `${count('previous')} דולגו כי קיבלו בעבר`],
      ['info', withHistory && `${withHistory} קיבלו מייל בעבר`],
      ['warn', count('suppressed') && `${count('suppressed')} ברשימת הסרה`],
      ...(abOn()
        ? ['A', 'B'].map((v) => {
            const of = state.rows.filter((r) => r.variant === v);
            const sent = of.filter((r) => r.status === 'sent').length;
            const ready = of.filter((r) => r.status === 'ready').length;
            return ['info', `גרסה ${v}: ${sent} נשלחו · ${ready} ממתינים`];
          })
        : []),
    ].filter(([, t]) => t);
    box.innerHTML = '';
    chips.forEach(([cls, text]) => {
      const c = document.createElement('span');
      c.className = `chip ${cls}`;
      c.textContent = text;
      box.appendChild(c);
    });
    $('#log-card').hidden = !state.rows.length;
  }

  function orgColumn() {
    return state.mapping['שם הארגון'] || Object.values(state.mapping).find(Boolean) || '';
  }

  function renderLog() {
    const tbody = $('#log tbody');
    const orgCol = orgColumn();
    $('#log-org-head').textContent = orgCol || 'שם';
    tbody.innerHTML = '';
    const frag = document.createDocumentFragment();
    state.rows.forEach((r, i) => {
      const tr = document.createElement('tr');
      tr.dataset.i = i;
      if (i === state.current) tr.className = 'current';
      const s = STATUS[r.status];
      const cells = [abOn() && r.variant ? `${i + 1} · ${r.variant}` : String(i + 1), r.email, orgCol ? r.cells[orgCol] : '', historyLabel(r.history), s.text + (r.reason ? `: ${r.reason}` : '')];
      cells.forEach((text, c) => {
        const td = document.createElement('td');
        td.textContent = text;
        if (c === 1) td.className = 'email';
        if (c === 3) {
          td.className = 'history';
          td.title = historyTitle(r.history);
        }
        if (c === 4) td.className = `status ${s.cls}`;
        if (c === 4 && r.reason) td.title = r.reason;
        tr.appendChild(td);
      });
      frag.appendChild(tr);
    });
    tbody.appendChild(frag);
  }

  function updateLogRow(i) {
    const tr = $(`#log tbody tr[data-i="${i}"]`);
    if (!tr) return;
    const r = state.rows[i];
    const s = STATUS[r.status];
    const td = tr.lastElementChild;
    td.className = `status ${s.cls}`;
    td.textContent = s.text + (r.reason ? `: ${r.reason}` : '');
    td.title = r.reason || '';
    const historyCell = tr.children[3];
    historyCell.textContent = historyLabel(r.history);
    historyCell.title = historyTitle(r.history);
  }

  // ---------- Preview ----------

  const previewRoot = $('#preview').attachShadow({ mode: 'open' });
  const PREVIEW_CSS = `
    :host { display: block; }
    .frame { background: #fff; color: #222; font: 14px/1.4 Arial, sans-serif; min-height: 100%; }
    .frame.mobile { width: 375px; margin: 0 auto; border-radius: 18px; overflow: hidden; box-shadow: 0 2px 10px rgba(0,0,0,.2); }
    img { max-width: 100%; }
  `;

  function currentMessage(row) {
    const values = row ? row.values : { ...state.values };
    const variant = (row && row.variant) || 'A';
    const result = analyze(sourceFor(variant), values, state.font);
    const subject = fillText(subjectFor(variant), values, baseFor(variant));
    return { result, subject };
  }

  function renderPreview() {
    const row = state.rows[state.current];
    $('#preview-pos').textContent =
      (state.rows.length ? `נמען ${state.current + 1} מתוך ${state.rows.length}` : 'תצוגה מקדימה') +
      (row && abOn() && row.variant ? ` · גרסה ${row.variant}` : '');
    $('#preview-to').textContent = row ? row.email : '';
    $('#preview-history').textContent =
      row && row.history.length
        ? `✓ קיבל מייל בעבר: ${row.history.map((h) => `${h.campaign} (${formatDate(h.at)})`).join(' · ')}`
        : '';
    if (!state.base) return;
    const { result, subject } = currentMessage(row);
    $('#preview-subject').textContent = subject;
    const status = $('#preview-status');
    status.textContent = row && row.status !== 'ready' ? `${STATUS[row.status].text}${row.reason ? `: ${row.reason}` : ''}` : '';
    status.className = row ? `status ${STATUS[row.status].cls}` : '';

    const mobile = state.prefs.device === 'mobile';
    const dark = state.prefs.theme !== 'light';
    $('#preview').className = `preview${mobile || dark ? ' alt' : ''}`;
    previewRoot.innerHTML = `<style>${PREVIEW_CSS}</style><div class="frame${mobile ? ' mobile' : ''}">${result.previewHtml}</div>`;
    if (dark) applyDarkMode(previewRoot.querySelector('.frame'), state.prefs.theme);
    document.querySelectorAll('[data-device]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.device === state.prefs.device));
    document.querySelectorAll('[data-theme]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.theme === state.prefs.theme));
    document.querySelectorAll('#log tbody tr.current').forEach((tr) => tr.classList.remove('current'));
    const tr = $(`#log tbody tr[data-i="${state.current}"]`);
    if (tr) tr.classList.add('current');
  }

  // ---------- Google sign-in ----------

  function authUrl(interactive) {
    const params = new URLSearchParams({
      client_id: state.clientId,
      response_type: 'token',
      redirect_uri: chrome.identity.getRedirectURL(),
      scope: SCOPES,
      include_granted_scopes: 'true',
      prompt: interactive ? 'select_account' : 'none',
    });
    if (state.account) params.set('login_hint', state.account);
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  }

  async function authorize(interactive) {
    if (!state.clientId) throw new Error('צריך להדביק Client ID (שלב 1)');
    const redirect = await chrome.identity.launchWebAuthFlow({ url: authUrl(interactive), interactive });
    const params = new URLSearchParams(new URL(redirect).hash.slice(1));
    if (params.get('error')) throw new Error(params.get('error'));
    state.token = params.get('access_token');
    // Refresh two minutes early so a send never starts with an expiring token
    state.tokenExpires = Date.now() + (Number(params.get('expires_in') || 3600) - 120) * 1000;
    const me = await fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${state.token}` } }).then((r) => r.json());
    if (me.email) {
      state.account = me.email;
      storage.set({ [MKEYS.account]: me.email });
    }
    renderAuth();
  }

  async function getToken() {
    if (state.token && Date.now() < state.tokenExpires) return state.token;
    try {
      await authorize(false);
    } catch {
      await authorize(true);
    }
    return state.token;
  }

  function renderAuth() {
    const connected = !!state.token;
    $('#auth-status').textContent = connected ? `מחובר: ${state.account}` : state.account ? `לא מחובר (${state.account})` : 'לא מחובר';
    $('#account-badge').textContent = connected ? `שולח מ-${state.account}` : '';
    $('#disconnect').hidden = !connected;
    $('#connect').textContent = connected ? 'החלפת חשבון' : 'התחברות ל-Google';
    if (connected && !$('#test-to').value) $('#test-to').value = state.account;
    $('#setup-guide').open = !state.clientId;
  }

  // ---------- Sending ----------

  function base64Utf8(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  const wrap76 = (s) => s.replace(/.{1,76}/g, '$&\r\n').trimEnd();
  const encodeHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${base64Utf8(s)}?=`);

  function htmlToText(html) {
    const div = document.createElement('div');
    div.innerHTML = html;
    div.querySelectorAll('[style*="display:none"], [style*="display: none"]').forEach((n) => n.remove());
    div.querySelectorAll('a[href^="http"]').forEach((a) => {
      if (a.textContent.trim() && a.textContent.trim() !== a.href) a.append(` (${a.getAttribute('href')})`);
    });
    div.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
    div.querySelectorAll('p, div, tr, h1, h2, h3, li, table').forEach((el) => el.append('\n'));
    return div.textContent.replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  function buildMime({ to, subject, html, unsubscribe }) {
    const fromName = $('#from-name').value.trim();
    const doc =
      '<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      `<title>${escapeHtml(subject)}</title></head><body style="margin:0;padding:0;">${html}</body></html>`;
    const boundary = `ghx_${crypto.randomUUID()}`;
    const headers = [
      fromName && state.account && `From: ${encodeHeader(fromName)} <${state.account}>`,
      `To: ${to}`,
      `Subject: ${encodeHeader(subject)}`,
      'MIME-Version: 1.0',
      unsubscribe && `List-Unsubscribe: <mailto:${unsubscribe}?subject=${encodeURIComponent('הסרה מרשימת התפוצה')}>`,
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
    ].filter(Boolean);
    const mime = [
      ...headers,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      wrap76(base64Utf8(htmlToText(html))),
      `--${boundary}`,
      'Content-Type: text/html; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      wrap76(base64Utf8(doc)),
      `--${boundary}--`,
      '',
    ].join('\r\n');
    return base64Utf8(mime).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  class SendError extends Error {
    constructor(message, { status, reason } = {}) {
      super(message);
      this.status = status;
      this.reason = reason || '';
    }
    get daily() {
      return /daily|dailyLimitExceeded|quotaExceeded/i.test(`${this.reason} ${this.message}`);
    }
    get rate() {
      return this.status === 429 || /rateLimitExceeded|userRateLimitExceeded/i.test(this.reason);
    }
  }

  async function sendMessage(to, values, variant = 'A') {
    const { result, subject } = currentMessage({ values, variant });
    const unsubscribe = $('#list-unsub').checked
      ? (values['מייל הנציג'] || '').trim() || state.base.varDefaults['מייל הנציג'] || state.account
      : '';
    const raw = buildMime({ to, subject, html: result.html, unsubscribe });

    for (let attempt = 0; ; attempt++) {
      const token = await getToken();
      const res = await fetch(SEND_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw }),
      });
      if (res.ok) return res.json();
      const body = await res.json().catch(() => ({}));
      const err = new SendError(body.error?.message || `HTTP ${res.status}`, {
        status: res.status,
        reason: body.error?.errors?.[0]?.reason || body.error?.status,
      });
      if (res.status === 401 && attempt === 0) {
        state.token = null; // expired early; get a new one and retry once
        continue;
      }
      if (err.rate && !err.daily && attempt < 3) {
        showMessage('info', 'Gmail ביקש להאט. ממתין דקה וממשיך…');
        await sleep(60000);
        continue;
      }
      throw err;
    }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function showMessage(kind, text) {
    const box = $('#message');
    box.hidden = !text;
    box.className = `message ${kind}`;
    box.textContent = text;
  }

  function renderProgress() {
    const done = state.rows.filter((r) => r.status === 'sent').length;
    const pending = state.rows.filter((r) => r.status === 'ready').length;
    const failed = state.rows.filter((r) => r.status === 'failed').length;
    const total = done + pending + failed;
    $('#progress').hidden = !total;
    $('#progress-fill').style.width = total ? `${(done / total) * 100}%` : '0';
    $('#progress-text').textContent = `${done} נשלחו · ${pending} ממתינים${failed ? ` · ${failed} נכשלו` : ''}`;
    $('#export').hidden = !(done || failed);
  }

  function setRunning(running) {
    state.running = running;
    $('#start').hidden = running;
    $('#pause').hidden = !running;
    for (const el of document.querySelectorAll('#step-template select, #step-template input, #step-list input, #step-list select, #step-list textarea, #campaign')) {
      el.disabled = running;
    }
  }

  async function startSending() {
    const pending = state.rows.filter((r) => r.status === 'ready');
    if (!pending.length) {
      showMessage('info', 'אין נמענים שממתינים לשליחה.');
      return;
    }
    if (!$('#campaign').value.trim()) {
      showMessage('err', 'צריך לתת שם לקמפיין.');
      return;
    }
    try {
      await getToken();
    } catch (e) {
      showMessage('err', `ההתחברות ל-Google נכשלה: ${e.message}`);
      return;
    }
    const minutes = Math.ceil((pending.length * Number($('#delay').value)) / 60);
    const problems = allTemplateProblems();
    const problemText = problems.length ? `\n\n⚠ בעיות בתבנית שיגיעו לכל הנמענים:\n• ${problems.map((p) => p.text).join('\n• ')}` : '';
    const split = abOn()
      ? `\nבדיקת A/B: ${pending.filter((r) => r.variant === 'A').length} יקבלו את "${$('#source').selectedOptions[0].text}", ` +
        `${pending.filter((r) => r.variant === 'B').length} יקבלו את "${$('#source-b').selectedOptions[0].text}".`
      : '';
    if (!confirm(`לשלוח ${pending.length} מיילים מהחשבון ${state.account}?${split}\nזמן משוער: כ-${minutes} דקות. צריך להשאיר את הלשונית הזאת פתוחה.${problemText}`)) return;

    setRunning(true);
    showMessage('info', 'שולח… אפשר לעבור ללשונית אחרת, אבל לא לסגור את הזאת.');
    let failures = 0;
    for (const row of state.rows) {
      if (!state.running) break;
      if (row.status !== 'ready') continue;
      const i = state.rows.indexOf(row);
      row.status = 'sending';
      updateLogRow(i);
      try {
        await sendMessage(row.email, row.values, row.variant);
        row.status = 'sent';
        row.reason = '';
        row.sentAt = new Date().toISOString();
        state.sentLog[campaignKey(row.email)] = row.sentAt;
        storage.set({ [MKEYS.sentLog]: state.sentLog });
        row.history.unshift({ campaign: $('#campaign').value.trim(), at: row.sentAt });
        failures = 0;
      } catch (e) {
        row.status = 'failed';
        row.reason = e.message;
        failures++;
        if (e.daily) {
          updateLogRow(i);
          showMessage('err', 'הגעתם למגבלת השליחה היומית של Gmail. אפשר להמשיך מחר: טוענים את אותו קובץ, ומי שכבר קיבל ידולג אוטומטית.');
          break;
        }
        if (failures >= MAX_CONSECUTIVE_FAILURES) {
          updateLogRow(i);
          showMessage('err', `${failures} כישלונות ברצף — השליחה נעצרה. השגיאה האחרונה: ${e.message}`);
          break;
        }
      }
      updateLogRow(i);
      renderProgress();
      renderSummary();
      if (state.rows.some((r) => r.status === 'ready') && state.running) await sleep(Number($('#delay').value) * 1000);
    }
    const wasRunning = state.running;
    setRunning(false);
    renderProgress();
    if (wasRunning && !state.rows.some((r) => r.status === 'ready')) {
      const sent = state.rows.filter((r) => r.status === 'sent').length;
      showMessage('ok', `הסתיים. נשלחו ${sent} מיילים.`);
    } else if (!wasRunning) {
      showMessage('info', 'השליחה הושהתה. "התחלת שליחה" ממשיכה מהנמען הבא.');
    }
  }

  async function sendTest() {
    const to = $('#test-to').value.trim();
    if (!EMAIL_RE.test(to)) {
      showMessage('err', 'כתובת הבדיקה לא תקינה.');
      return;
    }
    const row = state.rows[state.current];
    try {
      $('#send-test').disabled = true;
      await sendMessage(to, row ? row.values : { ...state.values }, row ? row.variant : 'A');
      showMessage('ok', `מייל בדיקה נשלח אל ${to}${row ? ` (עם הנתונים של ${row.email})` : ''}.`);
    } catch (e) {
      showMessage('err', `שליחת הבדיקה נכשלה: ${e.message}`);
    } finally {
      $('#send-test').disabled = false;
    }
  }

  function exportResults() {
    const cols = [...state.headers, 'סטטוס', 'פירוט', 'זמן שליחה', 'נשלח בעבר', ...(abOn() ? ['גרסה'] : [])];
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [cols.map(esc).join(',')];
    for (const r of state.rows) {
      const history = historyTitle(r.history).replace(/\n/g, '; ');
      lines.push([...state.headers.map((h) => r.cells[h]), STATUS[r.status].text, r.reason, r.sentAt || '', history, ...(abOn() ? [r.variant] : [])].map(esc).join(','));
    }
    // BOM so Excel opens the Hebrew correctly
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `תוצאות-${$('#campaign').value.trim() || 'קמפיין'}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---------- Backup: move settings between computers ----------

  const BACKUP_FORMAT = 'startupkid-gmail-composer-settings';
  // Belongs to this computer only: the code open in the editor, and "default template shown"
  const NOT_BACKED_UP = new Set([KEYS.draft, KEYS.defaultSeen]);
  // Kept as they are on the computer importing, unless empty there (another computer may be
  // signed in to a different Google account)
  const KEEP_LOCAL = new Set([MKEYS.clientId, MKEYS.account]);

  const isPlainObject = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const backupKeys = (obj) => Object.keys(obj).filter((k) => k.startsWith('ghx') && !NOT_BACKED_UP.has(k));

  // Nothing is lost on import: lists are united, the send history keeps the earliest time of
  // each send, and otherwise the file wins (it's what the user chose to bring over).
  function mergeSetting(key, local, incoming) {
    if (incoming === undefined || incoming === null) return local;
    if (local === undefined || local === null || local === '') return incoming;
    if (KEEP_LOCAL.has(key)) return local;
    if (Array.isArray(local) && Array.isArray(incoming)) return [...new Set([...local, ...incoming])];
    if (isPlainObject(local) && isPlainObject(incoming)) {
      if (key === MKEYS.sentLog) {
        const out = { ...local };
        for (const [k, at] of Object.entries(incoming)) if (!out[k] || at < out[k]) out[k] = at;
        return out;
      }
      return { ...local, ...incoming };
    }
    return incoming;
  }

  function describeSettings(data) {
    const count = (v) => (Array.isArray(v) ? v.length : isPlainObject(v) ? Object.keys(v).length : 0);
    // "ערך שדה אחד" / "3 ערכי שדות"
    const n = (num, one, many) => (num === 1 ? one : `${num} ${many}`);
    const vars = count(data[KEYS.vars]);
    const images = Object.keys(data[KEYS.vars] || {}).filter(isImageVar).length;
    return [
      data[MKEYS.clientId] ? 'Client ID' : '',
      vars && `${n(vars, 'ערך שדה אחד', 'ערכי שדות')}${images ? ` (${n(images, 'כולל תמונה אחת', 'מתוכם')}${images === 1 ? '' : ` ${images} תמונות`})` : ''}`,
      count(data[KEYS.templates]) && n(count(data[KEYS.templates]), 'תבנית שמורה אחת', 'תבניות שמורות'),
      count(data[MKEYS.sentLog]) && n(count(data[MKEYS.sentLog]), 'שליחה אחת בהיסטוריה', 'שליחות בהיסטוריה'),
      count(data[MKEYS.suppress]) && n(count(data[MKEYS.suppress]), 'כתובת אחת ברשימת ההסרה', 'כתובות ברשימת ההסרה'),
    ]
      .filter(Boolean)
      .join(' · ');
  }

  function backupMessage(kind, text) {
    const box = $('#backup-message');
    box.hidden = !text;
    box.className = `message ${kind}`;
    box.textContent = text;
  }

  async function exportSettings() {
    const all = await storage.get(null);
    const data = Object.fromEntries(backupKeys(all).map((k) => [k, all[k]]));
    const file = {
      format: BACKUP_FORMAT,
      version: 1,
      exportedAt: new Date().toISOString(),
      extensionVersion: chrome.runtime.getManifest ? chrome.runtime.getManifest().version : '',
      data,
    };
    const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `startupkid-gmail-settings-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    backupMessage('ok', `הקובץ ירד. הוא כולל: ${describeSettings(data) || 'הגדרות בסיסיות'}. במחשב השני: פותחים את העמוד הזה ← "ייבוא הגדרות".`);
  }

  async function importSettings(file) {
    if (state.running) {
      backupMessage('err', 'אי אפשר לייבא באמצע שליחה. עצרו את השליחה ונסו שוב.');
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      parsed = null;
    }
    if (!parsed || parsed.format !== BACKUP_FORMAT || !isPlainObject(parsed.data)) {
      backupMessage('err', 'זה לא קובץ הגדרות של התוסף. בוחרים את הקובץ שנוצר ב"ייצוא הגדרות" (startupkid-gmail-settings-….json).');
      return;
    }
    const incoming = Object.fromEntries(backupKeys(parsed.data).map((k) => [k, parsed.data[k]]));
    const when = parsed.exportedAt ? new Date(parsed.exportedAt).toLocaleString('he-IL') : 'לא ידוע';
    if (!confirm(`לייבא את ההגדרות מהקובץ (נוצר ${when})?\n${describeSettings(incoming)}\n\nהן יתמזגו עם מה שכבר יש כאן. שום דבר לא יימחק.`)) return;

    const local = await storage.get(Object.keys(incoming));
    const merged = Object.fromEntries(Object.keys(incoming).map((k) => [k, mergeSetting(k, local[k], incoming[k])]));
    await storage.set(merged);
    backupMessage('ok', 'ההגדרות יובאו. העמוד נטען מחדש… (בעורך ב-Gmail: סוגרים ופותחים אותו מחדש)');
    setTimeout(() => location.reload(), 1500);
  }

  // ---------- Wiring ----------

  async function init() {
    const data = await storage.get(Object.values(MKEYS));
    state.clientId = data[MKEYS.clientId] || '';
    state.account = data[MKEYS.account] || '';
    state.sentLog = data[MKEYS.sentLog] || {};
    state.suppress = new Set((data[MKEYS.suppress] || []).map((e) => e.toLowerCase()));
    const prefs = data[MKEYS.mergePrefs] || {};
    Object.assign(state.prefs, prefs.preview);
    $('#delay').value = prefs.delay || 6;
    $('#skip-previous').checked = !!prefs.skipPrevious;
    $('#from-name').value = prefs.fromName || '';
    $('#suppress').value = [...state.suppress].join('\n');
    $('#client-id').value = state.clientId;
    $('#redirect-uri').textContent = chrome.identity.getRedirectURL();
    renderAuth();

    const savePrefs = () =>
      storage.set({
        [MKEYS.mergePrefs]: {
          delay: Number($('#delay').value),
          fromName: $('#from-name').value,
          skipPrevious: $('#skip-previous').checked,
          preview: state.prefs,
        },
      });

    $('#client-id').addEventListener('change', () => {
      state.clientId = $('#client-id').value.trim();
      storage.set({ [MKEYS.clientId]: state.clientId });
      renderAuth();
    });
    $('#connect').addEventListener('click', async () => {
      try {
        state.account = ''; // let the user pick an account
        await authorize(true);
        showMessage('ok', `מחובר ל-${state.account}.`);
      } catch (e) {
        showMessage('err', `ההתחברות נכשלה: ${e.message}. ודאו שה-Client ID נכון ושכתובת ההפניה הוזנה ב-Google Cloud בדיוק כמו בשלב 5.`);
      }
    });
    $('#disconnect').addEventListener('click', () => {
      state.token = null;
      renderAuth();
    });
    $('#copy-redirect').addEventListener('click', () => navigator.clipboard.writeText(chrome.identity.getRedirectURL()));

    $('#ab-enabled').addEventListener('change', () => {
      state.ab.enabled = $('#ab-enabled').checked;
      $('#ab-box').hidden = !state.ab.enabled;
      renderTemplateWarnings();
      autoMap();
      renderMapping();
      buildRows();
    });
    $('#subject-b').addEventListener('input', renderPreview);
    $('#subject').addEventListener('input', () => {
      state.subjectEdited = true;
      if (!$('#campaign').dataset.edited) $('#campaign').value = $('#subject').value;
      renderPreview();
    });
    $('#campaign').addEventListener('input', () => {
      $('#campaign').dataset.edited = '1';
      buildRows();
    });
    $('#from-name').addEventListener('change', savePrefs);
    $('#delay').addEventListener('change', savePrefs);
    $('#skip-previous').addEventListener('change', () => {
      savePrefs();
      buildRows();
    });

    $('#file').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        await readFile(file);
        showMessage('', '');
      } catch (err) {
        showMessage('err', `לא הצלחתי לקרוא את הקובץ: ${err.message}`);
      }
    });
    $('#sheet').addEventListener('change', () => readSheet($('#sheet').value));
    $('#suppress').addEventListener('change', () => {
      const list = $('#suppress').value.split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
      state.suppress = new Set(list);
      storage.set({ [MKEYS.suppress]: list });
      buildRows();
    });

    $('#prev').addEventListener('click', () => {
      if (state.current > 0) state.current--;
      renderPreview();
    });
    $('#next').addEventListener('click', () => {
      if (state.current < state.rows.length - 1) state.current++;
      renderPreview();
    });
    $('#log tbody').addEventListener('click', (e) => {
      const tr = e.target.closest('tr');
      if (!tr) return;
      state.current = Number(tr.dataset.i);
      renderPreview();
    });
    document.querySelectorAll('[data-device]').forEach((b) =>
      b.addEventListener('click', () => {
        state.prefs.device = b.dataset.device;
        savePrefs();
        renderPreview();
      })
    );
    document.querySelectorAll('[data-theme]').forEach((b) =>
      b.addEventListener('click', () => {
        state.prefs.theme = b.dataset.theme;
        savePrefs();
        renderPreview();
      })
    );

    $('#send-test').addEventListener('click', sendTest);
    $('#start').addEventListener('click', startSending);
    $('#pause').addEventListener('click', () => {
      state.running = false;
      $('#pause').hidden = true;
      showMessage('info', 'עוצר אחרי המייל הנוכחי…');
    });
    $('#export').addEventListener('click', exportResults);
    $('#export-settings').addEventListener('click', () =>
      exportSettings().catch((e) => backupMessage('err', `הייצוא נכשל: ${e.message}`))
    );
    $('#import-settings').addEventListener('click', () => $('#import-file').click());
    $('#import-file').addEventListener('change', (e) => {
      const file = e.target.files[0];
      e.target.value = ''; // allow choosing the same file again
      if (file) importSettings(file).catch((err) => backupMessage('err', `הייבוא נכשל: ${err.message}`));
    });
    window.addEventListener('beforeunload', (e) => {
      if (state.running) e.preventDefault();
    });

    await loadSourceList();
    renderPreview();

    // Quietly restore the session if Google still has one for this account
    if (state.clientId && state.account) authorize(false).catch(() => {});
  }

  init();
})();
