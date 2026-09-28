// Shared by the Gmail editor (content.js) and the send-to-list page (merge.js):
// turns template source + variable values into email-ready HTML.
(() => {
  'use strict';

  const KEYS = { draft: 'ghxDraft', vars: 'ghxVars', templates: 'ghxTemplates', prefs: 'ghxPrefs', defaultSeen: 'ghxDefaultSeen' };
  // The editor opens with this template when it's empty. Bump DEFAULT_VERSION when the default
  // template changes, so the next open replaces an older draft with it once.
  const DEFAULT_TEMPLATE = 'b:startupkid';
  const DEFAULT_VERSION = 14;
  // Built-in templates, shown grouped by category. To add one: put the file in templates/
  // (see templates/README.md) and add a line here.
  const TEMPLATE_GROUPS = [
    { id: 'marketing', label: 'שיווק לארגונים — מתנ"סים, בתי ספר, חברות' },
    { id: 'parents', label: 'שיווק להורים' },
    { id: 'service', label: 'שירות לקוחות — הורים ומנויים' },
    { id: 'base', label: 'בסיס לעיצוב חדש' },
  ];
  const BUILTIN_TEMPLATES = [
    { id: 'startupkid', group: 'marketing', name: 'מתנ"סים וארגונים – תוכנית שנתית (ברירת מחדל)', file: 'templates/startupkid.html' },
    { id: 'schools', group: 'marketing', name: 'בתי ספר — תוכנית העשרה', file: 'templates/marketing/schools.html' },
    { id: 'hr-benefit', group: 'marketing', name: 'חברות — הטבת רווחה לילדי העובדים', file: 'templates/marketing/hr-benefit.html' },
    { id: 'org-followup', group: 'marketing', name: 'פולואפ קצר — "רק מוודא שהגיע"', file: 'templates/marketing/org-followup.html' },
    { id: 'lead-followup', group: 'parents', name: 'השאירו פרטים באתר — כל מה שצריך לדעת', file: 'templates/marketing/lead-followup.html' },
    { id: 'open-lesson', group: 'parents', name: 'הזמנה לשיעור פתוח', file: 'templates/marketing/open-lesson.html' },
    { id: 'referral', group: 'parents', name: 'חבר מביא חבר + הנחת אחים', file: 'templates/marketing/referral.html' },
    { id: 'newsletter', group: 'parents', name: 'עדכון חודשי — מה למדנו', file: 'templates/marketing/newsletter.html' },
    { id: 'win-back', group: 'parents', name: 'מתגעגעים — החזרת משפחות שעזבו', file: 'templates/marketing/win-back.html' },
    { id: 'welcome', group: 'service', name: 'ברוכים הבאים — אחרי הרשמה', file: 'templates/service/welcome.html' },
    { id: 'lesson-reminder', group: 'service', name: 'תזכורת למפגש', file: 'templates/service/lesson-reminder.html' },
    { id: 'missed-lesson', group: 'service', name: 'פספסתם מפגש — קישור להקלטה', file: 'templates/service/missed-lesson.html' },
    { id: 'holiday-break', group: 'service', name: 'אין מפגש השבוע — חג', file: 'templates/service/holiday-break.html' },
    { id: 'group-change', group: 'service', name: 'אישור מעבר קבוצה', file: 'templates/service/group-change.html' },
    { id: 'feedback-survey', group: 'service', name: 'בקשת משוב — איך היה עד עכשיו?', file: 'templates/service/feedback-survey.html' },
    { id: 'birthday', group: 'service', name: 'יום הולדת שמח לילד/ה', file: 'templates/service/birthday.html' },
    { id: 'invoice', group: 'service', name: 'חשבונית חודשית', file: 'templates/service/invoice.html' },
    { id: 'payment-failed', group: 'service', name: 'התשלום לא עבר — עדכון פרטי תשלום', file: 'templates/service/payment-failed.html' },
    { id: 'subscription-paused', group: 'service', name: 'אישור הקפאת מנוי', file: 'templates/service/subscription-paused.html' },
    { id: 'pause-ending', group: 'service', name: 'ההקפאה מסתיימת — חוזרים', file: 'templates/service/pause-ending.html' },
    { id: 'subscription-cancelled', group: 'service', name: 'אישור ביטול מנוי', file: 'templates/service/subscription-cancelled.html' },
    { id: 'refund', group: 'service', name: 'אישור החזר כספי', file: 'templates/service/refund.html' },
    { id: 'prize-shipped', group: 'service', name: 'הפרס בדרך — מימוש מטבעות', file: 'templates/service/prize-shipped.html' },
    { id: 'basic', group: 'base', name: 'תבנית בסיס (מותאמת נייד ומצב כהה)', file: 'templates/basic.html' },
  ];
  // [{ label, templates }] in display order, for <optgroup>s
  const builtinGroups = () =>
    TEMPLATE_GROUPS.map((g) => ({ label: g.label, templates: BUILTIN_TEMPLATES.filter((t) => t.group === g.id) })).filter((g) => g.templates.length);

  // Built-in templates can share parts, e.g. one header and signature for all customer
  // service emails: <!--#include file="partials/service-top.html" --> (path from templates/).
  // They're filled in when the template is loaded, so the editor shows the complete code.
  const INCLUDE_RE = /<!--#include\s+file="([^"]+)"\s*-->/g;
  async function loadBuiltin(id) {
    const t = BUILTIN_TEMPLATES.find((x) => x.id === id);
    if (!t) return null;
    const get = (path) => fetch(chrome.runtime.getURL(path)).then((r) => r.text());
    const resolve = async (html, depth) => {
      const parts = [...html.matchAll(INCLUDE_RE)];
      if (!parts.length || depth > 3) return html;
      const texts = await Promise.all(parts.map((m) => get(`templates/${m[1]}`).then((x) => resolve(x.trim(), depth + 1))));
      let i = 0;
      return html.replace(INCLUDE_RE, () => texts[i++]);
    };
    return resolve(await get(t.file), 0);
  }
  // Gmail hides everything past ~102KB of HTML behind "[Message clipped]"
  const GMAIL_CLIP_BYTES = 102 * 1024;
  // {{name}}, {{name|default value}}, or {{name#format}} to print the same value in another form
  const VAR_RE = /\{\{\s*([^{}|#]+?)\s*(?:#\s*(\w+)\s*)?(?:\|\s*([^{}]*?)\s*)?\}\}/g;

  const VAR_FORMATS = {
    // Israeli phone for links: 053-2822403 → 972532822403 (tel:+…, WhatsApp)
    intl: (v) => {
      const digits = v.replace(/\D/g, '');
      return digits.startsWith('0') ? `972${digits.slice(1)}` : digits;
    },
  };

  const storage = {
    get: (keys) => new Promise((resolve) => chrome.storage.local.get(keys, (d) => resolve(d || {}))),
    set: (obj) => chrome.storage.local.set(obj),
  };

  // ---------- Colors ----------

  const colorCtx = document.createElement('canvas').getContext('2d');

  function parseColor(value) {
    if (!value || value === 'transparent') return null;
    let v = value;
    if (!/^rgba?\(/.test(v)) {
      colorCtx.fillStyle = '#000';
      colorCtx.fillStyle = v;
      v = colorCtx.fillStyle;
      if (v[0] === '#') {
        return { r: parseInt(v.slice(1, 3), 16), g: parseInt(v.slice(3, 5), 16), b: parseInt(v.slice(5, 7), 16), a: 1 };
      }
    }
    const p = (v.match(/[\d.]+/g) || []).map(Number);
    if (p.length < 3) return null;
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }

  const brightness = (c) => (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) / 255;

  function rgbToHsl({ r, g, b }) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h / 6, s, l];
  }

  function hslToRgb(h, s, l) {
    if (!s) return { r: l * 255, g: l * 255, b: l * 255 };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const f = (t) => {
      t = (t + 1) % 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    return { r: f(h + 1 / 3) * 255, g: f(h) * 255, b: f(h - 1 / 3) * 255 };
  }

  // Approximates how Gmail apps recolor mail in dark mode:
  //  'partial' (Android): only light backgrounds and dark text are inverted
  //  'full'    (iPhone):  every color is inverted
  // Gradients and images are left untouched in both, like Gmail does.
  function darkColor(c, kind, mode) {
    const [h, s, l] = rgbToHsl(c);
    const invert = mode === 'full' || (kind === 'text' ? l < 0.5 : l > 0.5);
    if (!invert) return null;
    const { r, g, b } = hslToRgb(h, s, 1 - l);
    return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${c.a})`;
  }

  function applyDarkMode(container, mode) {
    const els = [container, ...container.querySelectorAll('*')];
    const sides = ['top', 'right', 'bottom', 'left'];
    // Read everything first: changing a parent would change children's inherited values
    const plan = els.map((el) => {
      const cs = getComputedStyle(el);
      return {
        el,
        color: parseColor(cs.color),
        bg: parseColor(cs.backgroundColor),
        borders: sides.map((s) => (parseFloat(cs.getPropertyValue(`border-${s}-width`)) ? parseColor(cs.getPropertyValue(`border-${s}-color`)) : null)),
      };
    });
    for (const { el, color, bg, borders } of plan) {
      const set = (prop, c, kind) => {
        const v = c && c.a > 0 && darkColor(c, kind, mode);
        if (v) el.style.setProperty(prop, v, 'important');
      };
      set('color', color, 'text');
      set('background-color', bg, 'bg');
      borders.forEach((c, i) => set(`border-${sides[i]}-color`, c, 'bg'));
    }
  }

  // ---------- HTML processing ----------

  const STRIP_TAGS = 'script,iframe,object,embed,frame,frameset,base,meta,link,noscript,applet';
  const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'xlink:href', 'background']);

  // A variable whose name starts with "תמונה" holds an image link, e.g. {{תמונה: באנר}}
  const isImageVar = (name) => name.startsWith('תמונה');

  // Order for listing variables. A phone number the template uses early (e.g. in a WhatsApp
  // link at the top) still belongs with the rest of its contact details, so it goes right
  // after the last variable of its group: "טלפון הנציג" after "מייל הנציג".
  function orderVars(names) {
    const group = (n) => n.trim().split(/\s+/).pop();
    const isPhone = (n) => n.startsWith('טלפון');
    const out = names.filter((n) => !isPhone(n));
    for (const phone of names.filter(isPhone)) {
      let at = out.length - 1;
      while (at >= 0 && group(out[at]) !== group(phone)) at--;
      out.splice(at < 0 ? out.length : at + 1, 0, phone);
    }
    return out;
  }

  // The file id in a Google Drive share link (or in a direct link made from one)
  function driveFileId(url) {
    const m = String(url).match(
      /(?:(?:drive|docs)\.google\.com\/(?:file\/d\/|open\?(?:.*&)?id=|uc\?(?:.*&)?id=|thumbnail\?(?:.*&)?id=)|lh3\.googleusercontent\.com\/d\/)([\w-]{20,})/
    );
    return m ? m[1] : '';
  }

  // Turns a Google Drive share link into a direct image URL that mail clients can load.
  // The file must be shared as "Anyone with the link".
  // A variable whose name starts with "קישור למסמך" is the link of a document button
  // (an invoice, a receipt, a form), e.g. {{קישור למסמך: חשבונית}}
  const isDocVar = (name) => name.startsWith('קישור למסמך');

  // Images that must not go out again, like the old app screenshot that greets "שמעון".
  // A link to one of them counts as empty wherever it's saved (field values, saved templates),
  // so the field asks for the current image instead.
  const RETIRED_DRIVE_IDS = ['1iv1PUoc6mqpdp-YaZGN8WxgBPFv3FeAc'];
  const isRetired = (link) => RETIRED_DRIVE_IDS.some((id) => String(link || '').includes(id));

  function driveToDirect(url) {
    const m = url.match(/(?:drive|docs)\.google\.com\/(?:file\/d\/|open\?(?:.*&)?id=|uc\?(?:.*&)?id=|thumbnail\?(?:.*&)?id=)([\w-]{20,})/);
    return m ? `https://lh3.googleusercontent.com/d/${m[1]}` : url;
  }

  const escapeHtml = (s) =>
    s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

  function specificity(selector) {
    const s = selector.replace(/\([^)]*\)/g, '');
    const ids = (s.match(/#[\w-]+/g) || []).length;
    const classes = (s.match(/\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+/g) || []).length;
    const types = (s.replace(/#[\w-]+|\.[\w-]+|\[[^\]]*\]|::?[\w-]+/g, ' ').match(/[a-zA-Z][\w-]*/g) || []).length;
    return ids * 10000 + classes * 100 + types;
  }

  function applyDeclarations(el, style) {
    for (let i = 0; i < style.length; i++) {
      const prop = style[i];
      el.style.setProperty(prop, style.getPropertyValue(prop), style.getPropertyPriority(prop));
    }
  }

  function inlineStyles(doc, stats) {
    const styleEls = [...doc.querySelectorAll('style')];
    if (!styleEls.length) return;

    // Remember the author's own inline styles so they win over stylesheet rules
    const originals = [...doc.querySelectorAll('[style]')].map((el) => [el, el.getAttribute('style')]);

    const rules = [];
    let order = 0;
    for (const styleEl of styleEls) {
      const sheet = new CSSStyleSheet();
      try {
        sheet.replaceSync(styleEl.textContent);
      } catch {
        continue;
      }
      for (const rule of sheet.cssRules) {
        if (rule instanceof CSSMediaRule) stats.media++;
        if (rule instanceof CSSFontFaceRule) stats.fontFace++;
        if (!(rule instanceof CSSStyleRule)) continue;
        for (const sel of rule.selectorText.split(',')) {
          if (/:(hover|focus|active|visited)|::/.test(sel)) stats.pseudo++;
          rules.push({ sel: sel.trim(), spec: specificity(sel), order: order++, style: rule.style });
        }
      }
    }
    rules.sort((a, b) => a.spec - b.spec || a.order - b.order);

    for (const r of rules) {
      let matches;
      try {
        matches = doc.querySelectorAll(r.sel);
      } catch {
        continue; // pseudo-elements and other unsupported selectors
      }
      matches.forEach((el) => applyDeclarations(el, r.style));
    }

    const scratch = document.createElement('div');
    for (const [el, css] of originals) {
      scratch.style.cssText = css;
      applyDeclarations(el, scratch.style);
    }

    styleEls.forEach((el) => el.remove());
  }

  // Only fonts that are already installed with Hebrew letters: Gmail doesn't load web fonts.
  // Each stack ends in a common font, so a recipient without the first one still gets clean
  // Hebrew. On phones most of these show as the phone's own Hebrew font.
  const FONTS = {
    tahoma: { label: 'Tahoma — ברור וקריא (מומלץ)', stack: 'Tahoma, Arial, sans-serif' },
    arial: { label: 'Arial — קלאסי, זהה כמעט בכל מקום', stack: 'Arial, Helvetica, sans-serif' },
    segoe: { label: 'Segoe UI — נקי ומודרני (Windows)', stack: "'Segoe UI', Tahoma, Arial, sans-serif" },
    system: { label: 'גופן המערכת — כמו אפליקציות בטלפון ובמחשב של הנמען', stack: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Noto Sans Hebrew', Arial, sans-serif" },
    gisha: { label: 'Gisha — עברי מעוגל וידידותי (Windows)', stack: "Gisha, 'Segoe UI', Arial, sans-serif" },
    david: { label: 'David — רשמי עם סריפים', stack: "David, 'Times New Roman', serif" },
    frank: { label: 'פרנק-ריהל — ספרותי ומכובד', stack: "FrankRuehl, 'Frank Ruehl', David, 'Times New Roman', serif" },
  };

  // One font for all text. Numeric weights are rounded to normal/bold because in-between
  // weights often map to a font file without Hebrew (e.g. Segoe UI Black for 800-900),
  // which makes the browser substitute a different font for those words.
  function unifyFonts(doc, stack) {
    const root = doc.body.firstElementChild;
    for (const el of doc.body.querySelectorAll('*')) {
      const hasText = [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
      if (el === root || hasText || el.style.fontFamily) el.style.fontFamily = stack;
      const weight = Number(el.style.fontWeight);
      if (weight) el.style.fontWeight = weight >= 600 ? 'bold' : 'normal';
    }
  }

  function analyze(source, values, font) {
    const varDefaults = {};
    for (const [, name, , def] of source.matchAll(VAR_RE)) {
      if (!(name in varDefaults) || (!varDefaults[name] && def)) varDefaults[name] = def || '';
    }
    const varNames = Object.keys(varDefaults);
    const usable = (name, v) => (v && !(isImageVar(name) && isRetired(v)) ? v : '');
    const valueOf = (name) => {
      const v = usable(name, (values[name] || '').trim()) || usable(name, varDefaults[name] || '');
      if (!v || !isImageVar(name)) return v;
      return /^https?:\/\/\S+$/i.test(v) ? driveToDirect(v) : '';
    };
    const missingVars = varNames.filter((n) => !valueOf(n));
    const filled = source.replace(VAR_RE, (whole, name, format) => {
      const v = valueOf(name);
      if (!v) return whole;
      return escapeHtml(VAR_FORMATS[format] ? VAR_FORMATS[format](v) : v);
    });

    const doc = new DOMParser().parseFromString(filled, 'text/html');
    const title = doc.title.trim();
    const stats = {
      media: 0,
      pseudo: 0,
      fontFace: 0,
      links: doc.querySelectorAll('link[rel~="stylesheet"]').length,
      scripts: doc.querySelectorAll('script').length,
    };

    doc.querySelectorAll(STRIP_TAGS).forEach((n) => n.remove());
    for (const el of doc.querySelectorAll('*')) {
      for (const attr of [...el.attributes]) {
        const name = attr.name.toLowerCase();
        if (name.startsWith('on') || (URL_ATTRS.has(name) && /^\s*javascript:/i.test(attr.value))) {
          el.removeAttribute(attr.name);
        }
      }
    }

    inlineStyles(doc, stats);

    // Styles and direction set on <html>/<body> would be lost, so carry them on a wrapper
    const outerStyle = [doc.documentElement.getAttribute('style'), doc.body.getAttribute('style')].filter(Boolean).join(';');
    const dir = doc.body.getAttribute('dir') || doc.documentElement.getAttribute('dir');
    if (outerStyle || dir) {
      const wrapper = doc.createElement('div');
      if (outerStyle) wrapper.setAttribute('style', outerStyle);
      if (dir) wrapper.setAttribute('dir', dir);
      wrapper.append(...doc.body.childNodes);
      doc.body.appendChild(wrapper);
    }

    if (FONTS[font]) unifyFonts(doc, FONTS[font].stack);

    const dataImages = [...new Set([...doc.querySelectorAll('img[src^="data:"]')].map((img) => img.getAttribute('src')))];

    // Gmail on iPhone keeps gradients as they are but inverts text colors in dark mode,
    // so light text over a gradient turns dark-on-dark.
    const gradientText = [];
    for (const el of doc.querySelectorAll('[style*="gradient"]')) {
      const text = el.textContent.replace(/\s+/g, ' ').trim();
      if (!text ||!/gradient/.test(el.style.backgroundImage)) continue;
      const colored = [el, ...el.querySelectorAll('[style*="color"]')];
      const hasLightText = colored.some((n) => {
        const c = parseColor(n.style.color);
        return c && brightness(c) > 0.7 && n.textContent.trim();
      });
      if (hasLightText) gradientText.push(text.slice(0, 40));
    }

    // data-ghx-fallback="templates/img/…" points at a bundled copy of an image, shown in the
    // preview until the real (public) link is filled in. It never goes into the email.
    const fallbacks = [...doc.querySelectorAll('[data-ghx-fallback]')].map((el) => {
      const file = el.getAttribute('data-ghx-fallback');
      el.removeAttribute('data-ghx-fallback');
      return [el, file];
    });
    const html = doc.body.innerHTML;
    for (const [el, file] of fallbacks) {
      if ((el.getAttribute('src') || '').includes('{{')) el.setAttribute('src', chrome.runtime.getURL(file));
    }
    const previewHtml = doc.body.innerHTML;
    const bytes = new Blob([html]).size;

    const warnings = [];
    if (dataImages.length) {
      warnings.push({
        level: 'error',
        text: `${dataImages.length} תמונות מוטמעות (base64) — Gmail לא מציג אותן לנמענים. צריך להחליף כל אחת בקישור ציבורי (https) לתמונה:`,
        images: dataImages,
      });
    }
    if (bytes > GMAIL_CLIP_BYTES) {
      warnings.push({ level: 'error', text: `גודל ה-HTML הוא ${Math.round(bytes / 1024)}KB. מעל 102KB Gmail חותך את ההודעה ומציג "[Message clipped]".` });
    }
    if (gradientText.length) {
      warnings.push({
        level: 'warn',
        text: `טקסט בהיר על רקע גרדיאנט (למשל: "${gradientText[0]}…"). ב-Gmail לאייפון במצב כהה הגרדיאנט נשאר כהה אבל הטקסט מתהפך לכהה — ולא ייקרא. עדיף רקע בצבע אחיד (background-color).`,
      });
    }
    if (stats.media) {
      warnings.push({
        level: 'warn',
        text: `${stats.media} כללי @media הוסרו — Gmail מוחק אותם כשכותבים מהדפדפן, כך שהתאמה לנייד או למצב כהה שמבוססת עליהם לא תעבוד. לעמודות שנערמות בנייד השתמשו ב-inline-block עם max-width (ראו "תבנית בסיס").`,
      });
    }
    if (stats.pseudo) warnings.push({ level: 'info', text: `${stats.pseudo} כללים כמו :hover הוסרו — אין להם תמיכה במייל.` });
    if (stats.links || stats.fontFace) {
      warnings.push({ level: 'info', text: 'גופנים חיצוניים (Google Fonts / @font-face) לא נטענים ב-Gmail — יוצג הגופן החלופי מתוך font-family.' });
    }
    if (stats.scripts) warnings.push({ level: 'info', text: 'תגי <script> הוסרו — מיילים לא מריצים קוד.' });
    for (const name of varNames.filter(isImageVar)) {
      const raw = (values[name] || '').trim() || varDefaults[name] || '';
      if (/drive\.google\.com\/drive\/(?:u\/\d+\/)?folders\//.test(raw)) {
        warnings.push({
          level: 'error',
          text: `"${name.replace(/^תמונה:?\s*/, '')}" מקושרת לתיקייה ב-Drive ולא לקובץ, ולכן לא תוצג. פתחו את התיקייה, לחיצה ימנית על התמונה עצמה ← שיתוף ← העתקת קישור.`,
        });
      }
    }
    for (const name of varNames.filter(isDocVar)) {
      const link = valueOf(name);
      if (link && !/^https?:\/\/\S+$/i.test(link)) {
        warnings.push({ level: 'error', text: `הקישור בכפתור "${name.replace(/^קישור למסמך:?\s*/, '')}" לא תקין — צריך להתחיל ב-https://` });
      }
    }

    // Which bundled file each image variable stands for, e.g. {{תמונה: כפתור}} → startupkid-button.png
    const imageFiles = {};
    for (const m of source.matchAll(/\{\{\s*(תמונה[^{}|]*?)\s*(?:\|[^{}]*)?\}\}"[^>]*?data-ghx-fallback="([^"]+)"/g)) {
      imageFiles[m[1]] = m[2];
    }

    return { html, previewHtml, title, varNames, varDefaults, missingVars, dataImages, imageFiles, warnings, bytes };
  }

  globalThis.GHX = {
    KEYS, DEFAULT_TEMPLATE, DEFAULT_VERSION, BUILTIN_TEMPLATES, builtinGroups, loadBuiltin, GMAIL_CLIP_BYTES, VAR_RE, VAR_FORMATS, FONTS,
    storage, parseColor, brightness, applyDarkMode, isImageVar, isDocVar, isRetired, orderVars, driveFileId, driveToDirect, escapeHtml, analyze,
  };
})();
