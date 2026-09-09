/* ============================================================================
   Client data layer.

   Every mutation is one HTTP call against one record. There is no whole-document
   save any more, so two people working at once no longer overwrite each other.
   ========================================================================== */

/** Normalises every failure into an Error carrying code, fields and status. */
async function request(method, path, body){
  let res;
  try{
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  }catch(networkError){
    const e = new Error('Could not reach the server. Check your connection.');
    e.code = 'OFFLINE';
    throw e;
  }
  let payload = null;
  const text = await res.text();
  try { payload = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }

  if(!res.ok){
    const info = (payload && payload.error) || {};
    const e = new Error(info.message || `Request failed (${res.status})`);
    e.status = res.status;
    e.code = info.code || 'UNKNOWN';
    e.fields = info.fields || null;
    e.current = info.current || null;   // the winning row, on a 409
    throw e;
  }
  return payload;
}

const API = {
  login: (email, password) => request('POST', '/api/auth/login', { email, password }),
  logout: () => request('POST', '/api/auth/logout', {}),
  me: () => request('GET', '/api/auth/me'),
  changePassword: (currentPassword, newPassword) =>
    request('POST', '/api/auth/password', { currentPassword, newPassword }),
  verifyMfa: code => request('POST', '/api/auth/mfa', { code }),
  mfaSetup: () => request('POST', '/api/auth/mfa/setup', {}),
  mfaEnable: code => request('POST', '/api/auth/mfa/enable', { code }),
  mfaDisable: password => request('POST', '/api/auth/mfa/disable', { password }),
  resetPassword: (token, newPassword) => request('POST', '/api/auth/reset', { token, newPassword }),
  issueResetToken: userId => request('POST', `/api/users/${userId}/reset-token`, {}),

  bootstrap: () => request('GET', '/api/bootstrap'),
  activity: () => request('GET', '/api/activity'),

  createAsset: a => request('POST', '/api/assets', a),
  updateAsset: (id, patch) => request('PUT', `/api/assets/${id}`, patch),
  deleteAsset: id => request('DELETE', `/api/assets/${id}`, {}),
  bulkAssets: (ids, patch) => request('POST', '/api/assets/bulk', { ids, patch }),
  importAssets: rows => request('POST', '/api/assets/import', { rows }),

  createSite: s => request('POST', '/api/sites', s),
  deleteSite: id => request('DELETE', `/api/sites/${id}`, {}),
  createDept: name => request('POST', '/api/departments', { name }),
  renameDept: (id, name) => request('PUT', `/api/departments/${id}`, { name }),
  deleteDept: id => request('DELETE', `/api/departments/${id}`, {}),
  createCompany: c => request('POST', '/api/companies', c),
  deleteCompany: id => request('DELETE', `/api/companies/${id}`, {}),

  createField: f => request('POST', '/api/fields', f),
  updateField: (id, patch) => request('PUT', `/api/fields/${id}`, patch),
  deleteField: id => request('DELETE', `/api/fields/${id}`, {}),

  createUser: u => request('POST', '/api/users', u),
  updateUser: (id, patch) => request('PUT', `/api/users/${id}`, patch),
  deleteUser: id => request('DELETE', `/api/users/${id}`, {}),

  getTheme: () => request('GET', '/api/settings/theme'),
  putTheme: t => request('PUT', '/api/settings/theme', t),
  resetTheme: logoAction => request('POST', '/api/settings/theme/reset', { logoAction }),
  putLogo: dataBase64 => request('POST', '/api/settings/logo', { data: dataBase64 }),
  deleteLogo: () => request('DELETE', '/api/settings/logo', {})
};

/** Reads a File as bare base64, without the data: prefix the server would strip. */
function fileToBase64(file){
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result);
      resolve(s.slice(s.indexOf(',') + 1));
    };
    r.onerror = () => reject(new Error('That file could not be read.'));
    r.readAsDataURL(file);
  });
}
