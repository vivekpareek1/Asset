/* ============================================================================
   Sign-in screen. Nothing else renders until there is a session.
   ========================================================================== */

let ME = null;

function renderLogin(message){
  document.body.innerHTML = `
  <div class="loginwrap">
    <form class="logincard" id="loginform" novalidate>
      <h1>AssetOps</h1>
      <p class="sub">IT asset register</p>
      ${message ? `<div class="alert e" role="alert">${esc(message)}</div>` : ''}
      <label class="f"><span>Email</span>
        <input type="email" id="lemail" autocomplete="username" autofocus required></label>
      <label class="f"><span>Password</span>
        <input type="password" id="lpass" autocomplete="current-password" required></label>
      <button class="btn p" id="lgo" type="submit" style="width:100%">Sign in</button>
      <p class="hint">Sessions last seven days. Signing out ends them straight away.</p>
      <button class="btn" id="lforgot" type="button" style="width:100%;margin-top:8px">I have a reset token</button>
    </form>
  </div>`;

  document.getElementById('lforgot').onclick = () => renderReset();
  const form = document.getElementById('loginform');
  form.onsubmit = async e => {
    e.preventDefault();
    const btn = document.getElementById('lgo');
    const email = document.getElementById('lemail').value.trim();
    const password = document.getElementById('lpass').value;
    if(!email || !password) return renderLogin('Enter both an email and a password.');
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span>Signing in…';
    try{
      const r = await API.login(email, password);
      if(r.mfaRequired) return renderMfa();
      ME = r.user;
      await boot();
    }catch(err){
      renderLogin(err.message);
      const f = document.getElementById('lemail');
      if(f) f.value = email;
    }
  };
}

/* --- second factor ------------------------------------------------------- */

function renderMfa(message){
  document.body.innerHTML = `
  <div class="loginwrap">
    <form class="logincard" id="mfaform" novalidate>
      <h1>Two-step check</h1>
      <p class="sub">One more step</p>
      ${message ? `<div class="alert e" role="alert">${esc(message)}</div>` : ''}
      <label class="f"><span>Six-digit code from your authenticator app</span>
        <input type="text" id="mcode" class="mono" inputmode="numeric" autocomplete="one-time-code"
               maxlength="14" autofocus required></label>
      <button class="btn p" id="mgo" type="submit" style="width:100%">Continue</button>
      <p class="hint">Lost your phone? Enter one of your recovery codes instead. Each one works once.</p>
      <button class="btn" id="mback" type="button" style="width:100%;margin-top:8px">Back to sign in</button>
    </form>
  </div>`;
  document.getElementById('mback').onclick = () => renderLogin();
  document.getElementById('mfaform').onsubmit = async e => {
    e.preventDefault();
    const btn = document.getElementById('mgo');
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span>Checking…';
    try{
      const r = await API.verifyMfa(document.getElementById('mcode').value.trim());
      ME = r.user;
      if(r.backupCodesRemaining !== undefined && r.backupCodesRemaining <= 2){
        await boot();
        toast(`Only ${r.backupCodesRemaining} recovery codes left. Generate new ones from your account.`);
        return;
      }
      await boot();
    }catch(err){
      renderMfa(err.code === 'NO_PENDING_LOGIN' ? 'That took too long. Sign in again.' : err.message);
    }
  };
}

/* --- reset a forgotten password ------------------------------------------ */

function renderReset(prefillToken){
  document.body.innerHTML = `
  <div class="loginwrap">
    <form class="logincard" id="rsform" novalidate>
      <h1>Set a new password</h1>
      <p class="sub">Using a reset token</p>
      <div id="rserr"></div>
      <label class="f"><span>Reset token</span>
        <input type="text" id="rstoken" class="mono" value="${esc(prefillToken||'')}" autofocus required></label>
      <label class="f"><span>New password</span>
        <input type="password" id="rspass" autocomplete="new-password" required></label>
      <button class="btn p" type="submit" id="rsgo" style="width:100%">Set the password</button>
      <p class="hint">At least 10 characters. Ask an administrator for a token if you do not have one. Tokens last an hour and work once.</p>
      <button class="btn" id="rsback" type="button" style="width:100%;margin-top:8px">Back to sign in</button>
    </form>
  </div>`;
  document.getElementById('rsback').onclick = () => renderLogin();
  document.getElementById('rsform').onsubmit = async e => {
    e.preventDefault();
    const btn = document.getElementById('rsgo');
    btn.disabled = true;
    try{
      await API.resetPassword(document.getElementById('rstoken').value.trim(),
                              document.getElementById('rspass').value);
      renderLogin('Password set. Sign in with it now.');
    }catch(err){
      btn.disabled = false;
      document.getElementById('rserr').innerHTML = `<div class="alert e" role="alert">${esc(err.message)}</div>`;
    }
  };
}

async function signOut(){
  try{ await API.logout(); }catch{ /* the session is going either way */ }
  ME = null; S = null;
  renderLogin('You have been signed out.');
}

/** A 401 mid-session means the account was disabled or the session revoked. */
function handleAuthLoss(err){
  if(err && err.status === 401){
    ME = null; S = null;
    renderLogin('Your session has ended. Please sign in again.');
    return true;
  }
  return false;
}
