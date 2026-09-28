chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // Opens the send-to-list page (the editor runs inside Gmail and can't open tabs itself)
  if (msg?.type === 'openMerge') {
    chrome.tabs.create({ url: chrome.runtime.getURL('merge.html') });
    return false;
  }

  // Checks whether an image link loads for someone who isn't signed in to Google.
  // The editor's preview runs inside Gmail with the sender's cookies, so it can't tell.
  if (msg?.type === 'checkImage') {
    fetch(msg.url, { credentials: 'omit', cache: 'no-store', redirect: 'follow' })
      .then((res) => {
        const type = res.headers.get('content-type') || '';
        sendResponse({ ok: res.ok && type.startsWith('image/'), status: res.status, type });
      })
      .catch(() => sendResponse({})); // offline or blocked: unknown, don't raise an alarm
    return true; // keep the channel open for the async response
  }

  // Drive image picker in the editor: browse folders, search, and share a file publicly
  if (msg?.type === 'drive') {
    drive(msg)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: err.message, reason: err.reason || '' }));
    return true;
  }
  return false;
});

// ---------- Google Drive ----------
// Uses the same OAuth client as the send-to-list page (its Client ID is saved there).

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_SCOPES = 'https://www.googleapis.com/auth/drive openid email';
const FOLDER = 'application/vnd.google-apps.folder';
const FILE_FIELDS = 'id,name,mimeType,thumbnailLink,parents,webViewLink,permissions(type,role)';
let driveAuth = null; // { token, expires }

function driveError(message, reason) {
  const err = new Error(message);
  err.reason = reason;
  return err;
}

async function authorizeDrive(interactive) {
  const { ghxOAuthClientId: clientId, ghxAccount: account } = await chrome.storage.local.get(['ghxOAuthClientId', 'ghxAccount']);
  if (!clientId) throw driveError('no client id', 'noClient');
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'token',
    redirect_uri: chrome.identity.getRedirectURL(),
    scope: DRIVE_SCOPES,
    include_granted_scopes: 'true',
    prompt: interactive ? 'select_account' : 'none',
  });
  if (account) params.set('login_hint', account);
  const redirect = await chrome.identity.launchWebAuthFlow({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params}`, interactive });
  const result = new URLSearchParams(new URL(redirect).hash.slice(1));
  if (result.get('error') || !result.get('access_token')) throw driveError(result.get('error') || 'no token', 'auth');
  driveAuth = {
    token: result.get('access_token'),
    expires: Date.now() + (Number(result.get('expires_in') || 3600) - 120) * 1000,
  };
  return driveAuth.token;
}

async function driveToken() {
  if (driveAuth && Date.now() < driveAuth.expires) return driveAuth.token;
  try {
    return await authorizeDrive(false);
  } catch (err) {
    if (err.reason === 'noClient') throw err;
    try {
      return await authorizeDrive(true);
    } catch (e) {
      throw e.reason ? e : driveError(e.message, 'auth'); // closed the sign-in window
    }
  }
}

async function driveFetch(path, init = {}, retried = false) {
  const token = await driveToken();
  const headers = { Authorization: `Bearer ${token}`, ...init.headers };
  if (typeof init.body === 'string') headers['Content-Type'] = 'application/json';
  const res = await fetch(path.startsWith('https:') ? path : `${DRIVE_API}${path}`, { ...init, headers });
  if (res.status === 401 && !retried) {
    driveAuth = null;
    return driveFetch(path, init, true);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = body.error || {};
    const reason = (e.errors && e.errors[0] && e.errors[0].reason) || (e.details || []).map((d) => d.reason).find(Boolean) || String(res.status);
    throw driveError(e.message || `HTTP ${res.status}`, reason);
  }
  return body;
}

const qs = (o) => new URLSearchParams({ supportsAllDrives: 'true', ...o }).toString();
const quote = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const isPublic = (f) => (f.permissions ? f.permissions.some((p) => p.type === 'anyone') : null);
const shape = (f) => ({
  id: f.id,
  name: f.name,
  folder: f.mimeType === FOLDER,
  thumb: f.thumbnailLink ? f.thumbnailLink.replace(/=s\d+$/, '=s240') : '',
  parent: (f.parents || [])[0] || '',
  link: f.webViewLink || '',
  public: isPublic(f), // null when Drive doesn't tell (e.g. files you can't share)
});

async function listFiles(q) {
  const { files = [] } = await driveFetch(
    `/files?${qs({
      q: `${q} and trashed = false and (mimeType contains 'image/' or mimeType = '${FOLDER}')`,
      fields: `files(${FILE_FIELDS})`,
      orderBy: 'folder,name_natural',
      pageSize: '300',
      includeItemsFromAllDrives: 'true',
      corpora: 'allDrives',
    })}`
  );
  return files.map(shape);
}

async function drive(msg) {
  switch (msg.op) {
    // The file an image field points at, to open the picker in its folder
    case 'file':
      return shape(await driveFetch(`/files/${encodeURIComponent(msg.id)}?${qs({ fields: FILE_FIELDS })}`));
    case 'folder': {
      const folder = await driveFetch(`/files/${encodeURIComponent(msg.id || 'root')}?${qs({ fields: 'id,name,parents' })}`);
      const files = await listFiles(`${quote(folder.id)} in parents`);
      return { folder: { id: folder.id, name: folder.name, parent: (folder.parents || [])[0] || '' }, files };
    }
    case 'search':
      return { files: await listFiles(`name contains ${quote(msg.query)}`) };
    // An image from the computer, into the folder open in the picker. Drive keeps it private
    // (or as shared as that folder) until it's shared with 'share' below.
    case 'upload': {
      const blob = await (await fetch(msg.dataUrl)).blob();
      const form = new FormData();
      form.append('metadata', new Blob([JSON.stringify({ name: msg.name, parents: [msg.folder || 'root'] })], { type: 'application/json' }));
      form.append('file', blob);
      const file = await driveFetch(`https://www.googleapis.com/upload/drive/v3/files?${qs({ uploadType: 'multipart', fields: FILE_FIELDS })}`, {
        method: 'POST',
        body: form,
      });
      return shape(file);
    }
    // "Anyone with the link" can view — what a recipient's mail app needs to load the image
    case 'share':
      await driveFetch(`/files/${encodeURIComponent(msg.id)}/permissions?${qs({})}`, {
        method: 'POST',
        body: JSON.stringify({ type: 'anyone', role: 'reader' }),
      });
      return true;
    default:
      throw driveError(`unknown op ${msg.op}`, 'op');
  }
}
