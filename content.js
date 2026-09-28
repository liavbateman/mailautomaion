(() => {
  'use strict';

  const BODY_SELECTOR = 'div[contenteditable="true"][g_editable="true"]';
  const {
    KEYS, DEFAULT_TEMPLATE, DEFAULT_VERSION, builtinGroups, loadBuiltin, GMAIL_CLIP_BYTES, FONTS,
    storage, applyDarkMode, isImageVar, isDocVar, isRetired, orderVars, driveFileId, driveToDirect, escapeHtml, analyze,
  } = globalThis.GHX;

  let savedRange = null;
  let modalOpen = false;

  // ---------- Compose detection ----------

  function findUp(body, selector) {
    let el = body.parentElement;
    for (let i = 0; el && i < 30; i++, el = el.parentElement) {
      const found = el.querySelector(selector);
      if (found) return found;
    }
    return null;
  }

  function attach(body) {
    // The bottom toolbar row of the compose window (the one with the Send button)
    const toolbar = findUp(body, 'tr.btC');
    if (!toolbar || toolbar.querySelector('.ghx-btn')) return;

    const btn = document.createElement('div');
    btn.className = 'ghx-btn';
    btn.textContent = '</>';
    btn.title = 'כתיבה ב-HTML (Ctrl+Shift+H)';
    btn.setAttribute('role', 'button');
    btn.tabIndex = 0;
    // mousedown fires before the body loses its selection
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      saveSelection(body);
    });
    btn.addEventListener('click', () => openEditor(body));
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openEditor(body);
      }
    });

    const td = document.createElement('td');
    td.appendChild(btn);
    toolbar.insertBefore(td, toolbar.children[1] || null);
  }

  function scan() {
    document.querySelectorAll(BODY_SELECTOR).forEach(attach);
  }

  let scanQueued = false;
  new MutationObserver(() => {
    if (scanQueued) return;
    scanQueued = true;
    requestAnimationFrame(() => {
      scanQueued = false;
      scan();
    });
  }).observe(document.body, { childList: true, subtree: true });
  scan();

  document.addEventListener(
    'keydown',
    (e) => {
      if (modalOpen || !(e.ctrlKey || e.metaKey) || !e.shiftKey || e.code !== 'KeyH') return;
      const body = document.activeElement && document.activeElement.closest(BODY_SELECTOR);
      if (!body) return;
      e.preventDefault();
      e.stopPropagation();
      saveSelection(body);
      openEditor(body);
    },
    true
  );

  function saveSelection(body) {
    const sel = window.getSelection();
    savedRange = null;
    if (sel.rangeCount) {
      const range = sel.getRangeAt(0);
      if (body.contains(range.commonAncestorContainer)) savedRange = range.cloneRange();
    }
  }

  // Asks the background worker to fetch an image link without any Google cookies, the way a
  // recipient's mail app would. Resolves {ok: true|false}, or {} when it couldn't be checked.
  const publicChecks = new Map();
  function checkPublic(url) {
    if (!/^https:\/\/([\w-]+\.)*(googleusercontent|google)\.com\//.test(url)) return Promise.resolve({});
    if (!publicChecks.has(url)) {
      publicChecks.set(
        url,
        new Promise((resolve) => {
          try {
            chrome.runtime.sendMessage({ type: 'checkImage', url }, (res) => resolve(chrome.runtime.lastError ? {} : res || {}));
          } catch {
            resolve({});
          }
        })
      );
    }
    return publicChecks.get(url);
  }

  // ---------- Insertion ----------

  function notifyGmail(el) {
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertHTML' }));
  }

  function insertAtCursor(body, html) {
    let range = savedRange;
    if (!range || !body.isConnected || !body.contains(range.commonAncestorContainer)) {
      range = document.createRange();
      range.setStart(body, 0);
      range.collapse(true);
    }

    const fragment = range.createContextualFragment(html);
    const last = fragment.lastChild;
    range.deleteContents();
    range.insertNode(fragment);

    body.focus();
    if (last) {
      const sel = window.getSelection();
      const after = document.createRange();
      after.setStartAfter(last);
      after.collapse(true);
      sel.removeAllRanges();
      sel.addRange(after);
    }
    notifyGmail(body);
  }

  function replaceBody(body, html) {
    body.innerHTML = html;
    body.focus();
    notifyGmail(body);
  }

  function fillSubject(body, subject) {
    const input = findUp(body, 'input[name="subjectbox"]');
    if (!input || !subject || input.value.trim()) return;
    input.value = subject;
    notifyGmail(input);
  }

  // ---------- Editor modal ----------

  const MODAL_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .backdrop {
      position: fixed; inset: 0; z-index: 2147483647;
      background: rgba(0,0,0,.45);
      display: flex; align-items: center; justify-content: center;
      font: 14px/1.4 "Google Sans", Roboto, Arial, sans-serif;
    }
    .modal {
      width: min(1440px, 96vw); height: 92vh;
      background: #fff; color: #1f1f1f; border-radius: 12px;
      box-shadow: 0 12px 40px rgba(0,0,0,.3);
      display: flex; flex-direction: column; overflow: hidden;
      direction: rtl;
    }
    header, footer { display: flex; align-items: center; gap: 8px; padding: 10px 16px; flex-wrap: wrap; }
    header { border-bottom: 1px solid #e3e3e3; }
    footer { border-top: 1px solid #e3e3e3; }
    header h2 { margin: 0 0 0 8px; font-size: 16px; font-weight: 500; }
    .grow { flex: 1; }
    .hint { color: #5f6368; font-size: 12px; }
    .panes { flex: 1; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); min-height: 0; }
    .pane { display: flex; flex-direction: column; min-height: 0; min-width: 0; }
    .pane + .pane { border-inline-start: 1px solid #e3e3e3; }
    .label {
      display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
      padding: 6px 12px; font-size: 12px; color: #5f6368;
      background: #f8f9fa; border-bottom: 1px solid #e3e3e3;
    }
    textarea {
      flex: 1; min-height: 120px; resize: none; border: 0; outline: 0; padding: 12px;
      font: 13px/1.5 Consolas, "Courier New", monospace; color: #1f1f1f;
      direction: ltr; text-align: left; tab-size: 2; white-space: pre;
    }
    .side { max-height: 45%; overflow: auto; border-top: 1px solid #e3e3e3; background: #fbfbfc; }
    .side:empty { display: none; }
    .section { padding: 10px 12px; }
    .section + .section { border-top: 1px solid #eee; }
    .section h3 { margin: 0 0 8px; font-size: 12px; font-weight: 600; color: #444746; }
    .row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
    .row label { min-width: 90px; font-size: 13px; color: #444746; }
    input[type=text], input[type=url] {
      flex: 1; min-width: 0; font: inherit; padding: 6px 10px;
      border: 1px solid #c4c7c5; border-radius: 8px; background: #fff; color: #1f1f1f;
    }
    input:focus { outline: 2px solid #0b57d0; outline-offset: -1px; }
    input.missing { border-color: #d93025; background: #fff8f7; }
    .warn { display: flex; gap: 8px; padding: 8px 10px; margin-bottom: 6px; border-radius: 8px; font-size: 13px; line-height: 1.5; }
    .warn.error { background: #fce8e6; color: #8c1d18; }
    .warn.warn { background: #fef7e0; color: #6d4c00; }
    .warn.info { background: #e8f0fe; color: #174ea6; }
    .warn .icon { flex: none; font-weight: 700; }
    .imgrow { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
    .imgrow img { width: 40px; height: 40px; object-fit: contain; background: #16153f; border-radius: 6px; flex: none; }
    .ok { color: #137333; font-size: 13px; }
    .seg { display: inline-flex; border: 1px solid #c4c7c5; border-radius: 16px; overflow: hidden; }
    .seg button { border: 0; border-radius: 0; padding: 4px 10px; font-size: 12px; color: #444746; background: #fff; }
    .seg button + button { border-inline-start: 1px solid #c4c7c5; }
    .seg button[aria-pressed=true] { background: #d3e3fd; color: #041e49; }
    .preview { flex: 1; overflow: auto; background: #fff; direction: ltr; }
    .preview.mobile, .preview.dark { background: #e8eaed; padding: 16px 0; }
    .note { font-size: 11px; color: #5f6368; }
    .vars .note { margin: -4px 0 8px; line-height: 1.5; }
    .varthumb {
      position: relative; width: 64px; height: 36px; padding: 0; flex: none; overflow: hidden;
      border: 1px solid transparent; border-radius: 6px; background: #e8eaed; cursor: pointer;
    }
    .varthumb img { width: 100%; height: 100%; object-fit: contain; display: block; }
    .varthumb.empty img { visibility: hidden; }
    .varthumb.empty::before { content: '+'; position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 18px; color: #5f6368; }
    .varthumb { transition: box-shadow .15s, border-color .15s; }
    .varthumb img { transition: filter .15s, transform .2s; }
    /* On hover: the image dims slightly and a small pencil chip appears in the corner */
    .varthumb::after {
      content: '✎'; position: absolute; bottom: 3px; inset-inline-end: 3px;
      width: 16px; height: 16px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
      background: rgba(255,255,255,.95); color: #3c4043; font-size: 10px; line-height: 1;
      box-shadow: 0 1px 3px rgba(0,0,0,.3); opacity: 0; transform: scale(.8); transition: opacity .15s, transform .15s;
    }
    .varthumb:hover, .varthumb:focus-visible { border-color: #c4c7c5; box-shadow: 0 1px 4px rgba(0,0,0,.15); background: #e8eaed; }
    .varthumb:hover img, .varthumb:focus-visible img { filter: brightness(.85); transform: scale(1.04); }
    .varthumb:hover::after, .varthumb:focus-visible::after { opacity: 1; transform: none; }
    button.remove.armed { background: #d93025; border-color: #d93025; color: #fff; }
    select.font { flex: 1; max-width: none; }
    /* ↺ stays out of the way once a field is filled in; it shows when pointing at the row */
    .vars .row .reset { visibility: hidden; }
    .vars .row:hover .reset, .vars .row:focus-within .reset { visibility: visible; }
    .vars h3 + .row, .vars .row + h3 { margin-top: 4px; }
    button {
      font: inherit; border-radius: 18px; padding: 8px 16px; cursor: pointer;
      border: 1px solid #c4c7c5; background: #fff; color: #0b57d0;
    }
    button:hover { background: #f0f4f9; }
    button.primary { background: #0b57d0; color: #fff; border-color: #0b57d0; }
    button.primary:hover { background: #0842a0; }
    button.small { padding: 4px 12px; font-size: 12px; }
    button[hidden] { display: none; }
    select { font: inherit; padding: 6px 10px; border: 1px solid #c4c7c5; border-radius: 8px; background: #fff; color: #1f1f1f; max-width: 280px; }
    .close { border: 0; font-size: 20px; line-height: 1; padding: 4px 10px; color: #444746; }
    .pback { position: fixed; inset: 0; z-index: 1; background: rgba(0,0,0,.35); display: flex; align-items: center; justify-content: center; }
    .picker {
      width: min(880px, 92vw); height: min(640px, 84vh); background: #fff; border-radius: 12px;
      box-shadow: 0 12px 40px rgba(0,0,0,.3); display: flex; flex-direction: column; overflow: hidden; direction: rtl;
    }
    .phead, .ptools, .pfoot { display: flex; align-items: center; gap: 8px; padding: 8px 14px; flex-wrap: wrap; }
    .phead { border-bottom: 1px solid #e3e3e3; }
    .phead h3 { margin: 0; font-size: 15px; font-weight: 500; }
    .ptools { background: #f8f9fa; border-bottom: 1px solid #e3e3e3; }
    .ptools .crumb { font-size: 13px; color: #444746; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ptools .psearch { flex: 0 1 260px; }
    .pfoot { border-top: 1px solid #e3e3e3; }
    .pfoot .pub { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #444746; }
    .pfoot .pub[hidden] { display: none; }
    .pfoot .psel { font-size: 12px; color: #5f6368; max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pfoot a { font-size: 12px; color: #0b57d0; }
    .pgrid {
      flex: 1; overflow: auto; padding: 12px; display: grid; gap: 10px; align-content: start;
      grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
    }
    .pgrid > .note, .pgrid > .warn { grid-column: 1 / -1; }
    .pgrid.drop { outline: 2px dashed #0b57d0; outline-offset: -8px; background: #f0f4f9; }
    .tile {
      position: relative; display: flex; flex-direction: column; gap: 6px; padding: 6px; border-radius: 10px;
      border: 2px solid transparent; background: #f1f3f4; color: #1f1f1f; text-align: center;
    }
    .tile:hover { background: #e8eaed; }
    .tile.current { border-color: #c4c7c5; }
    .tile.sel { border-color: #0b57d0; background: #e8f0fe; }
    .tile .pic { height: 90px; display: flex; align-items: center; justify-content: center; font-size: 40px; border-radius: 6px; background: #fff; overflow: hidden; }
    .tile.folder .pic { background: transparent; }
    .tile .pic img { max-width: 100%; max-height: 100%; object-fit: contain; }
    .tile .pname { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: ltr; }
    .tile .badge { position: absolute; top: 8px; inset-inline-start: 8px; font-size: 13px; }
    @media (max-width: 900px) { .panes { grid-template-columns: 1fr; grid-template-rows: 1fr 1fr; } }
  `;

  const PREVIEW_CSS = `
    :host { display: block; }
    .frame { background: #ffffff; color: #222222; font: 14px/1.4 Arial, Helvetica, sans-serif; min-height: 100%; }
    .frame.mobile { width: 375px; margin: 0 auto; min-height: 600px; border-radius: 18px; overflow: hidden; box-shadow: 0 2px 10px rgba(0,0,0,.2); }
    .frame.desktop.darkmode { width: calc(100% - 32px); margin: 0 auto; border-radius: 8px; overflow: hidden; }
    img { max-width: 100%; }
  `;

  function openEditor(body) {
    if (modalOpen) return;
    modalOpen = true;
    publicChecks.clear(); // sharing may have been fixed since the last check

    const host = document.createElement('div');
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>${MODAL_CSS}</style>
      <div class="backdrop">
        <div class="modal" role="dialog" aria-label="עורך HTML">
          <header>
            <h2>עורך HTML</h2>
            <select class="tpl" aria-label="תבניות"></select>
            <button class="small" data-act="save-tpl">שמירה כתבנית</button>
            <button class="small" data-act="delete-tpl" hidden>מחיקת התבנית</button>
            <button class="small" data-act="open-merge" title="שליחה מותאמת אישית לרשימת נמענים מקובץ Excel">📨 שליחה לרשימה מ-Excel</button>
            <span class="grow"></span>
            <button class="close" data-act="cancel" title="סגירה (Esc)">×</button>
          </header>
          <div class="panes">
            <div class="pane">
              <div class="label">קוד HTML <button class="small" data-act="add-image" title="מכניס תמונה מ-Drive במיקום הסמן בקוד">+ תמונה מ-Drive</button><button class="small" data-act="add-doc" title="כפתור שפותח מסמך (חשבונית, קבלה, טופס). נכנס לפני החתימה, והקישור ממולא בשדה משלו">+ כפתור למסמך</button><span class="grow"></span><span class="size"></span></div>
              <textarea spellcheck="false" placeholder="הדביקו כאן קוד HTML, או בחרו תבנית מהרשימה למעלה"></textarea>
              <div class="side">
                <div class="section">
                  <div class="row"><label for="ghx-subject">נושא המייל</label><input type="text" id="ghx-subject" class="subject" placeholder="ימולא בשדה הנושא של Gmail אם הוא ריק"></div>
                  <div class="row"><label for="ghx-font">גופן אחיד</label><select id="ghx-font" class="font">
                    ${Object.entries(FONTS).map(([id, f]) => `<option value="${id}" style="font-family:${f.stack.replace(/"/g, "'")}">${f.label}</option>`).join('')}
                    <option value="">ללא שינוי — הגופנים כפי שהם בקוד</option>
                  </select></div>
                </div>
                <div class="section vars" hidden></div>
                <div class="section warns"></div>
              </div>
            </div>
            <div class="pane">
              <div class="label">
                תצוגה מקדימה
                <span class="seg device">
                  <button data-device="desktop">מחשב</button><button data-device="mobile">נייד</button>
                </span>
                <span class="seg theme">
                  <button data-theme="light">בהיר</button><button data-theme="partial">כהה · אנדרואיד</button><button data-theme="full">כהה · אייפון</button>
                </span>
                <span class="note theme-note"></span>
              </div>
              <div class="preview"></div>
            </div>
          </div>
          <footer>
            <span class="hint grow">Ctrl+Enter — החלפת גוף המייל · Esc — סגירה · <code>{{שם}}</code> יוצר משתנה</span>
            <button data-act="load">טעינת תוכן המייל הנוכחי</button>
            <button data-act="insert">הוספה במיקום הסמן</button>
            <button class="primary" data-act="replace">החלפת גוף המייל</button>
          </footer>
        </div>
      </div>`;

    // Keep keystrokes inside the editor from triggering Gmail's keyboard shortcuts
    for (const type of ['keydown', 'keypress', 'keyup']) {
      host.addEventListener(type, (e) => e.stopPropagation());
    }

    const $ = (sel) => root.querySelector(sel);
    const textarea = $('textarea');
    const subjectInput = $('.subject');
    const fontSelect = $('select.font');
    const varsBox = $('.vars');
    const warnsBox = $('.warns');
    const sizeLabel = $('.size');
    const tplSelect = $('.tpl');
    const deleteTplBtn = $('[data-act="delete-tpl"]');
    const previewBox = $('.preview');
    const previewRoot = previewBox.attachShadow({ mode: 'open' });

    let values = {};
    let savedTemplates = {};
    let currentSaved = null;
    let prefs = { device: 'desktop', theme: 'light', font: 'tahoma' };
    let subjectEdited = false;
    let result = null;
    let varsKey = null;
    let warnsKey = null;
    let timer = null;
    let imageErrorsBox = null;
    const brokenImages = new Set();
    const privateImages = new Set();
    let previewRenderId = 0;

    // --- rendering ---

    function renderPreview() {
      const mobile = prefs.device === 'mobile';
      const dark = prefs.theme !== 'light';
      previewBox.className = `preview ${prefs.device}${dark ? ' dark' : ''}`;
      previewRoot.innerHTML = `<style>${PREVIEW_CSS}</style><div class="frame ${mobile ? 'mobile' : 'desktop'}${dark ? ' darkmode' : ''}">${result.previewHtml}</div>`;
      if (dark) applyDarkMode(previewRoot.querySelector('.frame'), prefs.theme);

      // A link that doesn't load here won't load for recipients either
      brokenImages.clear();
      privateImages.clear();
      renderImageErrors();
      const images = previewRoot.querySelectorAll('img[src^="http"]');
      images.forEach((img) => {
        img.addEventListener('error', () => {
          brokenImages.add(img.getAttribute('src'));
          renderImageErrors();
        });
      });
      // The preview loads images with the sender's Google sign-in, so a Drive file that isn't
      // public still shows here. Check each link again the way a recipient would see it.
      const renderId = ++previewRenderId;
      new Set([...images].map((img) => img.getAttribute('src'))).forEach((src) => {
        checkPublic(src).then((res) => {
          if (renderId !== previewRenderId || res.ok !== false) return;
          privateImages.add(src);
          renderImageErrors();
        });
      });

      root.querySelectorAll('[data-device]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.device === prefs.device));
      root.querySelectorAll('[data-theme]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.theme === prefs.theme));
      $('.theme-note').textContent = dark ? 'הדמיה משוערת — כדאי לבדוק גם במכשיר אמיתי' : '';
    }

    function varRow(name) {
      const row = document.createElement('div');
      row.className = 'row';
      const label = document.createElement('label');
      label.textContent = isImageVar(name) ? name.replace(/^תמונה:?\s*/, '') || name : name;
      // A link to a retired image (see isRetired) shows as empty, so the upload button appears
      const live = (v) => (isImageVar(name) && isRetired(v) ? '' : v || '');
      const def = live(result.varDefaults[name]);
      const input = document.createElement('input');
      input.type = isImageVar(name) ? 'url' : 'text';
      input.placeholder = def
        ? `ברירת מחדל: ${def}`
        : isImageVar(name)
          ? 'https://drive.google.com/file/d/…'
          : isDocVar(name)
            ? 'קישור לצפייה במסמך (https://…)'
            : '';
      if (isDocVar(name)) {
        input.type = 'url';
        label.textContent = `📄 ${name.replace(/^קישור למסמך:?\s*/, '') || 'מסמך'}`;
        label.title = 'הקישור שנפתח בלחיצה על הכפתור במייל';
      }
      input.dataset.var = name;
      input.value = live(values[name]) || def;
      row.append(label, input);

      // Back to the value written in the template, {{name|default}}
      const reset = document.createElement('button');
      reset.className = 'small reset';
      reset.textContent = '↺';
      reset.title = 'חזרה לברירת המחדל';
      const syncReset = () => {
        reset.hidden = !def || input.value.trim() === def;
      };

      // Image fields: clicking the thumbnail opens the Drive picker to swap the image
      let thumb = null;
      let thumbBtn = null;
      const file = result.imageFiles[name];
      const syncThumb = () => {
        if (!thumb) return;
        const url = driveToDirect(input.value.trim());
        thumb.src = /^https?:\/\/\S+$/i.test(url) ? url : file ? chrome.runtime.getURL(file) : '';
        thumbBtn.classList.toggle('empty', !thumb.getAttribute('src'));
      };
      if (isImageVar(name)) {
        thumbBtn = document.createElement('button');
        thumbBtn.className = 'varthumb';
        thumbBtn.title = 'לחיצה להחלפת התמונה מ-Google Drive';
        thumbBtn.setAttribute('aria-label', `החלפת התמונה ${label.textContent}`);
        thumb = document.createElement('img');
        thumb.alt = '';
        thumbBtn.appendChild(thumb);
        if (file) {
          const fileName = file.split('/').pop();
          label.title = `הקובץ המקורי: ${fileName}`;
          if (!def) input.placeholder = `קישור Drive לקובץ ${fileName}`;
        }
        thumbBtn.addEventListener('click', () =>
          openDrivePicker(label.textContent, input.value.trim(), (link) => {
            input.value = link;
            save();
          })
        );
        row.insertBefore(thumbBtn, input);
      }

      // An image that so far exists only inside the extension (like a new banner): one click
      // uploads the bundled copy to Drive, shares it, and fills in the link
      let syncUpload = () => {};
      if (isImageVar(name) && file) {
        const upload = document.createElement('button');
        upload.className = 'small';
        upload.textContent = '⬆ העלאה ל-Drive';
        upload.title = 'מעלה את התמונה מהתוסף ל-Google Drive, משתף אותה ל"כל מי שיש לו את הקישור" וממלא את הקישור';
        syncUpload = () => {
          upload.hidden = !!input.value.trim();
        };
        upload.addEventListener('click', async () => {
          upload.disabled = true;
          upload.textContent = 'מעלה…';
          try {
            const blob = await fetch(chrome.runtime.getURL(file)).then((r) => r.blob());
            const dataUrl = await new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result);
              reader.onerror = reject;
              reader.readAsDataURL(blob);
            });
            const added = await driveCall({ op: 'upload', name: file.split('/').pop(), folder: 'root', dataUrl });
            await driveCall({ op: 'share', id: added.id });
            input.value = added.link || `https://drive.google.com/file/d/${added.id}/view`;
            save();
          } catch (err) {
            alert(driveErrorText(err));
          } finally {
            upload.disabled = false;
            upload.textContent = '⬆ העלאה ל-Drive';
            syncUpload();
          }
        });
        row.insertBefore(upload, input.nextSibling);
      }

      const save = () => {
        const v = input.value.trim();
        if (!v || v === def) delete values[name];
        else values[name] = input.value;
        storage.set({ [KEYS.vars]: values });
        syncReset();
        syncThumb();
        syncUpload();
        schedule(false);
      };
      input.addEventListener('input', save);
      reset.addEventListener('click', () => {
        input.value = def;
        save();
      });

      if (isImageVar(name) || isDocVar(name)) {
        // Two steps: the first click turns the button into a red "delete?" for a few seconds
        const what = isDocVar(name) ? 'הכפתור' : 'התמונה';
        const remove = document.createElement('button');
        remove.className = 'small remove';
        remove.textContent = '🗑';
        remove.title = `הסרת ${what} מהמייל`;
        let armed = null;
        const disarm = () => {
          clearTimeout(armed);
          armed = null;
          remove.classList.remove('armed');
          remove.textContent = '🗑';
          remove.title = `הסרת ${what} מהמייל`;
        };
        remove.addEventListener('click', () => {
          if (!armed) {
            remove.classList.add('armed');
            remove.textContent = 'למחוק? לחצו שוב';
            remove.title = `לחיצה נוספת תסיר את ${what} מהמייל`;
            armed = setTimeout(disarm, 4000);
            return;
          }
          disarm();
          if (isDocVar(name)) removeDocButton(name);
          else removeImage(name);
        });
        remove.addEventListener('blur', disarm);
        row.appendChild(remove);
      } else {
        row.appendChild(reset);
      }
      syncReset();
      syncThumb();
      syncUpload();
      return row;
    }

    function driveCall(msg) {
      return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ type: 'drive', ...msg }, (res) => {
          if (chrome.runtime.lastError || !res) return reject({ error: chrome.runtime.lastError?.message || 'no response' });
          res.ok ? resolve(res.data) : reject(res);
        });
      });
    }

    function driveErrorText(err) {
      const reason = (err && err.reason) || '';
      if (reason === 'noClient') return 'כדי להעלות ל-Drive צריך קודם להתחבר ל-Google: הגדירו Client ID בעמוד "שליחה לרשימה מ-Excel" (שלב 1).';
      if (/accessNotConfigured|SERVICE_DISABLED/.test(reason)) return 'Google Drive API לא מופעל בפרויקט ב-Google Cloud. הפעילו אותו, המתינו דקה ונסו שוב.';
      if (reason === 'auth') return 'ההתחברות ל-Google בוטלה או נכשלה. נסו שוב.';
      return `ההעלאה ל-Drive נכשלה: ${(err && (err.error || err.message)) || 'שגיאה לא ידועה'}`;
    }

    // Inserts an <img> for a Drive image at the cursor, as an image variable so it shows up
    // in the image fields and can be swapped later.
    function addDriveImage() {
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const name = (prompt('שם לתמונה (למשל: לוגו שותף):') || '').trim().replace(/[{}|]/g, '');
      if (!name) return;
      const link = (prompt('קישור שיתוף מ-Google Drive:') || '').trim();
      if (!/^https?:\/\/\S+$/i.test(link)) {
        if (link) alert('זה לא נראה כמו קישור. העתיקו את הקישור מ-Drive: שיתוף ← העתקת קישור.');
        return;
      }
      const varName = `תמונה: ${name}`;
      const snippet =
        `<img src="{{${varName}|${link}}}" width="576" alt="${escapeHtml(name)}" ` +
        'style="display:block;width:100%;max-width:576px;height:auto;border:0;border-radius:12px;margin:0 auto;">';
      textarea.focus();
      textarea.setSelectionRange(start, end);
      document.execCommand('insertText', false, snippet);
      schedule();
    }

    // Browses Google Drive for a replacement image, starting in the folder of the current one,
    // and can share the chosen file as "anyone with the link" so recipients see it.
    function openDrivePicker(label, currentLink, onPick) {
      const currentId = driveFileId(currentLink);
      const box = document.createElement('div');
      box.className = 'pback';
      box.innerHTML = `
        <div class="picker" role="dialog">
          <div class="phead">
            <h3></h3><span class="grow"></span>
            <button class="close" data-p="close" title="סגירה (Esc)">×</button>
          </div>
          <div class="ptools">
            <button class="small" data-p="up" title="לתיקייה שמעל">↑ למעלה</button>
            <button class="small" data-p="root">האחסון שלי</button>
            <span class="crumb grow"></span>
            <button class="small" data-p="upload" title="מעלה תמונה מהמחשב לתיקייה הפתוחה (אפשר גם לגרור קובץ לכאן)">⬆ העלאה מהמחשב</button>
            <input type="file" class="pfile" accept="image/*" hidden>
            <input type="text" class="psearch" placeholder="חיפוש תמונה בכל ה-Drive…">
          </div>
          <div class="pgrid"></div>
          <div class="pfoot">
            <label class="pub"><input type="checkbox" checked> להפוך לציבורית — "כל מי שיש לו את הקישור" יכול לצפות (נדרש כדי שהנמענים יראו)</label>
            <span class="grow"></span>
            <span class="psel"></span>
            <a class="popen" target="_blank" rel="noopener" hidden>פתיחה ב-Drive ↗</a>
            <button class="primary" data-p="choose" disabled>בחירה</button>
          </div>
        </div>`;
      const q = (s) => box.querySelector(s);
      const grid = q('.pgrid');
      const search = q('.psearch');
      const chooseBtn = q('[data-p="choose"]');
      const publicBox = q('.pub input');
      q('h3').textContent = `בחירת תמונה מ-Drive — ${label}`;

      let folder = null; // { id, name, parent }
      let shown = []; // files in the grid
      let selected = null;
      let loadId = 0;
      let searchTimer = null;

      const close = () => {
        clearTimeout(searchTimer);
        box.remove();
      };
      const call = (msg) =>
        new Promise((resolve, reject) => {
          chrome.runtime.sendMessage({ type: 'drive', ...msg }, (res) => {
            if (chrome.runtime.lastError || !res) return reject({ error: chrome.runtime.lastError?.message || 'no response' });
            res.ok ? resolve(res.data) : reject(res);
          });
        });

      function showError(err) {
        grid.innerHTML = '';
        const msg = document.createElement('div');
        msg.className = 'warn error';
        const text = document.createElement('div');
        text.className = 'grow';
        const reason = err.reason || '';
        if (reason === 'noClient') {
          text.textContent = 'כדי לבחור תמונות מ-Drive צריך להתחבר ל-Google. הגדירו Client ID בעמוד "שליחה לרשימה מ-Excel" (שלב 1) ונסו שוב.';
          const open = document.createElement('button');
          open.className = 'small';
          open.textContent = 'לעמוד ההגדרה';
          open.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'openMerge' }));
          text.append(document.createElement('br'), open);
        } else if (/accessNotConfigured|SERVICE_DISABLED/.test(reason)) {
          text.textContent = 'Google Drive API לא מופעל בפרויקט של ה-Client ID ב-Google Cloud. הפעילו אותו (לחיצה על "Enable"), המתינו דקה ונסו שוב: ';
          const a = document.createElement('a');
          a.href = 'https://console.cloud.google.com/apis/library/drive.googleapis.com';
          a.target = '_blank';
          a.textContent = 'הפעלת Drive API';
          text.appendChild(a);
        } else if (reason === 'auth') {
          text.textContent = 'ההתחברות ל-Google לא הושלמה. נסו שוב ואשרו גישה ל-Drive.';
        } else {
          text.textContent = `שגיאה מ-Drive: ${err.error || reason}`;
        }
        msg.append(text);
        grid.appendChild(msg);
      }

      function select(file, tile) {
        selected = file;
        grid.querySelectorAll('.tile.sel').forEach((t) => t.classList.remove('sel'));
        if (tile) tile.classList.add('sel');
        chooseBtn.disabled = !file;
        q('.psel').textContent = file ? `${file.name}${file.public ? ' · ציבורית ✓' : file.public === false ? ' · לא ציבורית' : ''}` : '';
        const open = q('.popen');
        open.hidden = !file || !file.link;
        if (file && file.link) open.href = file.link;
        publicBox.parentElement.hidden = !!(file && file.public);
      }

      function renderFiles(files, emptyText, selectId = currentId) {
        shown = files;
        grid.innerHTML = '';
        select(null);
        if (!files.length) {
          grid.innerHTML = `<div class="note">${emptyText}</div>`;
          return;
        }
        for (const f of files) {
          const tile = document.createElement('button');
          tile.className = `tile${f.folder ? ' folder' : ''}`;
          tile.title = f.name;
          const pic = document.createElement('div');
          pic.className = 'pic';
          if (f.folder) pic.textContent = '📁';
          else if (f.thumb) {
            const img = document.createElement('img');
            img.src = f.thumb;
            img.alt = '';
            img.referrerPolicy = 'no-referrer';
            img.loading = 'lazy';
            pic.appendChild(img);
          } else pic.textContent = '🖼';
          const name = document.createElement('span');
          name.className = 'pname';
          name.textContent = f.name;
          tile.append(pic, name);
          if (!f.folder && f.public) {
            const badge = document.createElement('span');
            badge.className = 'badge';
            badge.textContent = '🌐';
            badge.title = 'ציבורית — כל מי שיש לו את הקישור';
            tile.appendChild(badge);
          }
          if (f.id === currentId) tile.classList.add('current');
          tile.addEventListener('click', () => (f.folder ? openFolder(f.id) : select(f, tile)));
          if (!f.folder) tile.addEventListener('dblclick', choose);
          grid.appendChild(tile);
          if (f.id === selectId) {
            select(f, tile);
            tile.scrollIntoView({ block: 'nearest' });
          }
        }
      }

      async function openFolder(id) {
        const my = ++loadId;
        search.value = '';
        grid.innerHTML = '<div class="note">טוען…</div>';
        try {
          const data = await call({ op: 'folder', id });
          if (my !== loadId) return;
          folder = data.folder;
          q('.crumb').textContent = `📁 ${folder.parent ? folder.name : 'האחסון שלי'}`;
          q('[data-p="up"]').disabled = !folder.parent;
          renderFiles(data.files, 'אין תמונות בתיקייה הזו');
        } catch (err) {
          if (my === loadId) showError(err);
        }
      }

      async function runSearch() {
        const text = search.value.trim();
        if (!text) return openFolder(folder && folder.id);
        const my = ++loadId;
        grid.innerHTML = '<div class="note">מחפש…</div>';
        try {
          const data = await call({ op: 'search', query: text });
          if (my !== loadId) return;
          q('.crumb').textContent = `🔍 תוצאות עבור "${text}"`;
          renderFiles(data.files, 'לא נמצאו תמונות');
        } catch (err) {
          if (my === loadId) showError(err);
        }
      }

      // Uploads into the open folder and selects the new file. It starts out private, so
      // "בחירה" shares it when the public checkbox is on (it is by default).
      async function upload(file) {
        if (!file) return;
        if (!file.type.startsWith('image/')) return alert('אפשר להעלות רק קובץ תמונה (JPG, PNG, GIF…).');
        if (file.size > 20 * 1024 * 1024) return alert('הקובץ גדול מ-20MB — כבד מדי למייל. כדאי להקטין אותו קודם.');
        const uploadBtn = q('[data-p="upload"]');
        uploadBtn.disabled = true;
        uploadBtn.textContent = 'מעלה…';
        try {
          const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject({ error: 'לא הצלחנו לקרוא את הקובץ' });
            reader.readAsDataURL(file);
          });
          const target = folder ? folder.id : 'root';
          const added = await call({ op: 'upload', name: file.name, folder: target, dataUrl });
          added.thumb = dataUrl; // Drive makes its thumbnail a bit later
          ++loadId; // a folder or search still loading would replace the grid
          search.value = '';
          if (folder) q('.crumb').textContent = `📁 ${folder.parent ? folder.name : 'האחסון שלי'}`;
          renderFiles([added, ...shown.filter((f) => f.id !== added.id)], '', added.id);
          q('.psel').textContent += ' · הועלתה ✓';
        } catch (err) {
          showError(err);
        } finally {
          uploadBtn.disabled = false;
          uploadBtn.textContent = '⬆ העלאה מהמחשב';
        }
      }

      async function choose() {
        if (!selected) return;
        const file = selected;
        if (publicBox.checked && !file.public) {
          chooseBtn.disabled = true;
          chooseBtn.textContent = 'משתף…';
          try {
            await call({ op: 'share', id: file.id });
          } catch (err) {
            chooseBtn.disabled = false;
            chooseBtn.textContent = 'בחירה';
            const why = /sharingRateLimit|cannotShare|forbidden|insufficientFilePermissions|publishOutNotPermitted|403/.test(err.reason || '')
              ? 'אין הרשאה לשתף את הקובץ לציבור (ייתכן שמדיניות הארגון חוסמת שיתוף מחוץ לארגון, או שהקובץ לא שלכם).'
              : `לא הצלחנו לשתף את הקובץ: ${err.error || err.reason}`;
            if (!confirm(`${why}\n\nלבחור את התמונה בכל זאת? הנמענים לא יראו אותה עד שתשתפו אותה.`)) return;
          }
        }
        const link = `https://drive.google.com/file/d/${file.id}/view`;
        publicChecks.delete(driveToDirect(link)); // sharing just changed
        close();
        onPick(link);
      }

      box.addEventListener('click', (e) => {
        const act = e.target.closest('[data-p]');
        if (e.target === box || (act && act.dataset.p === 'close')) close();
        else if (act && act.dataset.p === 'up' && folder && folder.parent) openFolder(folder.parent);
        else if (act && act.dataset.p === 'root') openFolder('root');
        else if (act && act.dataset.p === 'choose') choose();
        else if (act && act.dataset.p === 'upload') q('.pfile').click();
      });
      q('.pfile').addEventListener('change', (e) => {
        upload(e.target.files[0]);
        e.target.value = '';
      });
      grid.addEventListener('dragover', (e) => {
        if (![...e.dataTransfer.types].includes('Files')) return;
        e.preventDefault();
        grid.classList.add('drop');
      });
      grid.addEventListener('dragleave', (e) => {
        if (!grid.contains(e.relatedTarget)) grid.classList.remove('drop');
      });
      grid.addEventListener('drop', (e) => {
        e.preventDefault();
        grid.classList.remove('drop');
        upload(e.dataTransfer.files[0]);
      });
      box.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation(); // close only the picker, not the whole editor
          close();
        } else if (e.key === 'Enter' && e.target === search) {
          e.preventDefault();
          clearTimeout(searchTimer);
          runSearch();
        }
      });
      search.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(runSearch, 400);
      });

      $('.modal').appendChild(box);
      search.focus();

      // Open where the current image lives, or at the top of My Drive
      if (!currentId) return openFolder('root');
      grid.innerHTML = '<div class="note">טוען…</div>';
      call({ op: 'file', id: currentId })
        .then((file) => openFolder(file.parent || 'root'))
        .catch((err) => (err.reason === 'noClient' || err.reason === 'auth' || /accessNotConfigured|SERVICE_DISABLED/.test(err.reason || '') ? showError(err) : openFolder('root')));
    }

    // Removes every <img> that uses this image variable, together with a link wrapped only
    // around it (like the call-to-action button). Ctrl+Z in the code brings it back.
    function removeImage(name) {
      // Confirmed by the second click on the row's 🗑 button
      const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const img = `<img\\b[^>]*\\{\\{\\s*${esc}\\s*(?:#\\s*\\w+\\s*)?(?:\\|[^{}]*)?\\}\\}[^>]*>`;
      const next = textarea.value.replace(new RegExp(`<a\\b[^>]*>\\s*${img}\\s*</a>|${img}`, 'g'), '');
      if (next === textarea.value) return;
      textarea.focus();
      textarea.select();
      document.execCommand('insertText', false, next); // keeps the change undoable
      delete values[name];
      storage.set({ [KEYS.vars]: values });
      schedule(true, 0);
    }

    // A document button is marked by comments, so it can be found and removed as a whole:
    // <!-- DOC BUTTON --> … {{קישור למסמך: name}} … <!-- /DOC BUTTON -->
    const DOC_BLOCK_RE = /[ \t]*<!-- DOC BUTTON -->[\s\S]*?<!-- \/DOC BUTTON -->[ \t]*\r?\n?/g;

    function docButtonSnippet(varName, text, link) {
      return [
        '<!-- DOC BUTTON -->',
        '<tr><td align="center" style="padding:22px 32px 4px;text-align:center;">',
        ' <table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center"><tr><td bgcolor="#4a22b8" align="center" style="border-radius:999px;background:#4a22b8;">',
        `  <a href="{{${varName}${link ? `|${link}` : ''}}}" target="_blank" style="display:inline-block;padding:14px 34px;font-family:Tahoma,Arial,sans-serif;font-size:16px;font-weight:bold;line-height:1.3;color:#ffffff;text-decoration:none;border-radius:999px;">${escapeHtml(text)} ←</a>`,
        ' </td></tr></table>',
        '</td></tr>',
        '<!-- /DOC BUTTON -->',
        '',
      ].join('\n');
    }

    // Adds a button that opens a document (an invoice, a receipt, a form). It goes right before
    // the signature, where a call to action belongs; the link is filled in its own field.
    function addDocButton() {
      const text = (prompt('הטקסט על הכפתור:', 'לצפייה במסמך') || '').trim().replace(/\s*←$/, '');
      if (!text) return;
      let link = (prompt('קישור למסמך (אפשר להשאיר ריק ולמלא אחר כך בשדה):') || '').trim();
      if (link && !/^https?:\/\/\S+$/i.test(link)) {
        alert('זה לא נראה כמו קישור, אז הכפתור נוסף בלי קישור. אפשר להדביק אותו בשדה של הכפתור.');
        link = '';
      }
      const name = text.replace(/^לצפייה\s+(?:ב|ב־)?/, '').replace(/[{}|#]/g, '').trim() || 'מסמך';
      let varName = `קישור למסמך: ${name}`;
      for (let n = 2; textarea.value.includes(`{{${varName}`); n++) varName = `קישור למסמך: ${name} ${n}`;
      const snippet = docButtonSnippet(varName, text, link);

      const code = textarea.value;
      const marker = ['<!-- Shared bottom of', '<!-- SIGNATURE -->'].map((m) => code.indexOf(m)).filter((i) => i >= 0).sort((a, b) => a - b)[0];
      textarea.focus();
      if (marker === undefined) {
        // No known signature: insert at the cursor, like the image button does
      } else {
        const lineStart = code.lastIndexOf('\n', marker - 1) + 1;
        textarea.setSelectionRange(lineStart, lineStart);
      }
      document.execCommand('insertText', false, snippet + (marker === undefined ? '' : '\n'));
      schedule();
    }

    function removeDocButton(name) {
      const next = textarea.value.replace(DOC_BLOCK_RE, (block) => (block.includes(`{{${name}`) ? '' : block));
      if (next === textarea.value) return;
      textarea.focus();
      textarea.select();
      document.execCommand('insertText', false, next); // keeps the change undoable
      delete values[name];
      storage.set({ [KEYS.vars]: values });
      schedule(true, 0);
    }

    function markMissing() {
      varsBox.querySelectorAll('input[data-var]').forEach((input) => {
        input.classList.toggle('missing', result.missingVars.includes(input.dataset.var));
      });
    }

    function renderVars() {
      const key = result.varNames.join('\u0000');
      if (key !== varsKey) {
        varsKey = key;
        varsBox.hidden = !result.varNames.length;
        varsBox.innerHTML = '';
        const textVars = orderVars(result.varNames.filter((n) => !isImageVar(n)));
        const imageVars = result.varNames.filter(isImageVar);
        if (textVars.length) {
          const h = document.createElement('h3');
          h.textContent = 'משתנים — ימולאו במייל במקום {{…}}';
          varsBox.append(h, ...textVars.map(varRow));
        }
        if (imageVars.length) {
          const h = document.createElement('h3');
          h.textContent = 'תמונות — קישור שיתוף מ-Google Drive (נשמר לפעם הבאה)';
          const hint = document.createElement('div');
          hint.className = 'note';
          hint.textContent = 'לחיצה על התמונה פותחת את התיקייה שלה ב-Drive לבחירת תמונה אחרת או העלאה מהמחשב, ומשתפת אותה לציבור. אפשר גם להדביק קישור שיתוף ("כל מי שיש לו את הקישור").';
          varsBox.append(h, hint, ...imageVars.map(varRow));
        }
        imageErrorsBox = document.createElement('div');
        varsBox.appendChild(imageErrorsBox);
      }
      markMissing();
    }

    function renderImageErrors() {
      if (!imageErrorsBox) return;
      imageErrorsBox.innerHTML = '';
      // "תמונה אחת לא נטענת" / "3 תמונות לא נטענות"
      const count = (n, one, many) => (n === 1 ? `תמונה אחת ${one}` : `${n} תמונות ${many}`);
      const add = (text) => {
        const box = document.createElement('div');
        box.className = 'warn error';
        box.textContent = text;
        imageErrorsBox.appendChild(box);
      };
      if (brokenImages.size) {
        add(`⛔ ${count(brokenImages.size, 'לא נטענת', 'לא נטענות')} —ודאו שהקישור נכון ושהקובץ ב-Drive משותף ל"כל מי שיש לו את הקישור".`);
      }
      const hidden = [...privateImages].filter((src) => !brokenImages.has(src));
      if (hidden.length) {
        add(`⛔ ${count(hidden.length, 'מוצגת', 'מוצגות')} רק לכם,כי אתם מחוברים לחשבון Google. הנמענים יראו מסגרת ריקה. ב-Drive: שיתוף ← "גישה כללית" ← "כל מי שיש לו את הקישור" (ולא רק אנשים בארגון).`);
      }
    }

    function renderWarnings() {
      const key = JSON.stringify([!textarea.value.trim(), ...result.warnings.map((w) => w.text)]);
      if (key === warnsKey) return;
      warnsKey = key;
      warnsBox.innerHTML = '';
      if (!textarea.value.trim()) return;
      if (!result.warnings.length) {
        warnsBox.innerHTML = '<div class="ok">✓ לא נמצאו בעיות תאימות ל-Gmail</div>';
        return;
      }
      const icons = { error: '⛔', warn: '⚠', info: 'ℹ' };
      for (const w of result.warnings) {
        const box = document.createElement('div');
        box.className = `warn ${w.level}`;
        const icon = document.createElement('span');
        icon.className = 'icon';
        icon.textContent = icons[w.level];
        const content = document.createElement('div');
        content.className = 'grow';
        content.textContent = w.text;
        for (const src of w.images || []) content.appendChild(imageRow(src));
        box.append(icon, content);
        warnsBox.appendChild(box);
      }
    }

    function imageRow(src) {
      const row = document.createElement('div');
      row.className = 'imgrow';
      const thumb = document.createElement('img');
      thumb.src = src;
      thumb.alt = '';
      const input = document.createElement('input');
      input.type = 'url';
      input.placeholder = `https://… (${Math.round((src.length * 3) / 4 / 1024)}KB)`;
      const btn = document.createElement('button');
      btn.className = 'small';
      btn.textContent = 'החלפה';
      const apply = () => {
        const url = driveToDirect(input.value.trim());
        if (!/^https?:\/\/\S+$/i.test(url)) {
          input.classList.add('missing');
          input.focus();
          return;
        }
        textarea.value = textarea.value.split(src).join(url);
        schedule(true, 0);
      };
      btn.addEventListener('click', apply);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          apply();
        }
      });
      row.append(thumb, input, btn);
      return row;
    }

    function refresh() {
      result = analyze(textarea.value, values, prefs.font);
      if (!subjectEdited) subjectInput.value = result.title;
      sizeLabel.textContent = textarea.value.trim() ? `${Math.max(1, Math.round(result.bytes / 1024))}KB` : '';
      renderVars();
      renderWarnings();
      renderPreview();
    }

    function schedule(saveDraft = true, delay = 200) {
      clearTimeout(timer);
      timer = setTimeout(() => {
        refresh();
        if (saveDraft) storage.set({ [KEYS.draft]: textarea.value });
      }, delay);
    }

    // --- templates ---

    function renderTemplateList() {
      tplSelect.innerHTML = '';
      const placeholder = new Option('תבניות…', '');
      placeholder.disabled = true;
      placeholder.selected = true;
      tplSelect.appendChild(placeholder);
      for (const g of builtinGroups()) {
        const group = document.createElement('optgroup');
        group.label = g.label;
        g.templates.forEach((t) => group.appendChild(new Option(t.name, `b:${t.id}`)));
        tplSelect.appendChild(group);
      }
      const names = Object.keys(savedTemplates).sort((a, b) => a.localeCompare(b, 'he'));
      if (names.length) {
        const mine = document.createElement('optgroup');
        mine.label = 'התבניות שלי';
        names.forEach((n) => mine.appendChild(new Option(n, `s:${n}`)));
        tplSelect.appendChild(mine);
      }
      deleteTplBtn.hidden = !currentSaved;
    }

    async function loadTemplate(value, { force = false } = {}) {
      const [kind, id] = [value.slice(0, 1), value.slice(2)];
      let html;
      if (kind === 'b') {
        html = await loadBuiltin(id);
      } else {
        html = savedTemplates[id];
      }
      if (html == null) return;
      if (!force && textarea.value.trim() && textarea.value !== html && !confirm('להחליף את הקוד שבעורך בתבנית?')) return;
      currentSaved = kind === 's' ? id : null;
      textarea.value = html;
      subjectEdited = false;
      schedule(true, 0);
      renderTemplateList();
    }

    function saveTemplate() {
      if (!textarea.value.trim()) return;
      const name = (prompt('שם לתבנית:', currentSaved || '') || '').trim();
      if (!name) return;
      if (savedTemplates[name] != null && name !== currentSaved && !confirm(`כבר קיימת תבנית בשם "${name}". להחליף אותה?`)) return;
      savedTemplates[name] = textarea.value;
      currentSaved = name;
      storage.set({ [KEYS.templates]: savedTemplates });
      renderTemplateList();
    }

    function deleteTemplate() {
      if (!currentSaved || !confirm(`למחוק את התבנית "${currentSaved}"?`)) return;
      delete savedTemplates[currentSaved];
      currentSaved = null;
      storage.set({ [KEYS.templates]: savedTemplates });
      renderTemplateList();
    }

    // --- actions ---

    const close = () => {
      clearTimeout(timer);
      storage.set({ [KEYS.draft]: textarea.value });
      host.remove();
      modalOpen = false;
    };

    function confirmSend() {
      result = analyze(textarea.value, values, prefs.font);
      const problems = [];
      const missingText = result.missingVars.filter((n) => !isImageVar(n));
      const missingImages = result.missingVars.filter(isImageVar);
      if (missingText.length) problems.push(`משתנים ריקים: ${missingText.join(', ')}`);
      if (missingImages.length) problems.push(`תמונות בלי קישור (לא יוצגו לנמען): ${missingImages.join(', ')}`);
      if (brokenImages.size) problems.push('יש תמונות שהקישור שלהן לא נטען');
      if (privateImages.size) problems.push('יש תמונות שלא משותפות לציבור — הנמענים לא יראו אותן');
      if (result.dataImages.length) problems.push(`${result.dataImages.length} תמונות מוטמעות שלא יוצגו ב-Gmail`);
      if (result.bytes > GMAIL_CLIP_BYTES) problems.push('ההודעה גדולה מ-102KB ו-Gmail יחתוך אותה');
      return !problems.length || confirm(`שימו לב:\n• ${problems.join('\n• ')}\n\nלהמשיך בכל זאת?`);
    }

    const actions = {
      cancel: () => {
        close();
        body.focus();
      },
      load: () => {
        if (textarea.value.trim() && !confirm('להחליף את הקוד שבעורך בתוכן המייל הנוכחי?')) return;
        textarea.value = body.innerHTML;
        schedule();
        textarea.focus();
      },
      replace: () => {
        if (!confirmSend()) return;
        const { html } = result;
        const subject = subjectInput.value.trim();
        close();
        replaceBody(body, html);
        fillSubject(body, subject);
      },
      insert: () => {
        if (!confirmSend()) return;
        const { html } = result;
        const subject = subjectInput.value.trim();
        close();
        insertAtCursor(body, html);
        fillSubject(body, subject);
      },
      'add-image': addDriveImage,
      'add-doc': addDocButton,
      'open-merge': () => {
        // The list page picks up the code open here as "התבנית הפתוחה בעורך"
        Promise.resolve(storage.set({ [KEYS.draft]: textarea.value })).then(() => chrome.runtime.sendMessage({ type: 'openMerge' }));
      },
      'save-tpl': saveTemplate,
      'delete-tpl': deleteTemplate,
    };

    root.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]');
      if (act) return actions[act.dataset.act]();
      const device = e.target.closest('[data-device]');
      const theme = e.target.closest('[data-theme]');
      if (device) prefs.device = device.dataset.device;
      if (theme) prefs.theme = theme.dataset.theme;
      if (device || theme) {
        storage.set({ [KEYS.prefs]: prefs });
        renderPreview();
      } else if (e.target.classList.contains('backdrop')) {
        actions.cancel();
      }
    });

    tplSelect.addEventListener('change', () => {
      const value = tplSelect.value;
      tplSelect.selectedIndex = 0;
      if (value) loadTemplate(value);
    });
    subjectInput.addEventListener('input', () => {
      subjectEdited = true;
    });
    fontSelect.addEventListener('change', () => {
      prefs.font = fontSelect.value;
      storage.set({ [KEYS.prefs]: prefs });
      refresh();
    });
    textarea.addEventListener('input', () => schedule());
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault();
        document.execCommand('insertText', false, '  ');
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        actions.replace();
      }
    });
    $('.modal').addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        actions.cancel();
      }
    });

    document.body.appendChild(host);
    textarea.focus();

    storage.get([KEYS.draft, KEYS.vars, KEYS.templates, KEYS.prefs, KEYS.defaultSeen]).then((data) => {
      values = data[KEYS.vars] || {};
      savedTemplates = data[KEYS.templates] || {};
      prefs = Object.assign(prefs, data[KEYS.prefs]);
      fontSelect.value = prefs.font;
      renderTemplateList();

      const newDefault = data[KEYS.defaultSeen] !== DEFAULT_VERSION;
      if (newDefault || !(data[KEYS.draft] || '').trim()) {
        storage.set({ [KEYS.defaultSeen]: DEFAULT_VERSION });
        loadTemplate(DEFAULT_TEMPLATE, { force: true });
        return;
      }
      if (!textarea.value) textarea.value = data[KEYS.draft];
      refresh();
    });
  }
})();
