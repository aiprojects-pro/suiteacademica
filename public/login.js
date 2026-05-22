// ── CSRF helper (necesario para el paso 2 del login con TOTP) ────────────────
function readCookie(name){
  const m = document.cookie.match('(?:^|; )' + name.replace(/([.$?*|{}()\[\]\\\/\+^])/g,'\\$1') + '=([^;]*)');
  return m ? decodeURIComponent(m[1]) : null;
}

const params = new URLSearchParams(window.location.search);
if (params.get('msg') === 'session_expired') {
  const m = document.getElementById('msgBox');
  m.textContent = 'Tu sesión ha expirado. Inicia sesión de nuevo.';
  m.style.display = 'block';
}

document.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    if (document.getElementById('totpStep')?.style.display === 'block') doTotp();
    else doLogin();
  }
});

async function doLogin() {
  const btn = document.getElementById('btnLogin');
  const err = document.getElementById('errorBox');
  const u   = document.getElementById('username').value.trim();
  const p   = document.getElementById('password').value;
  if (!u || !p) { showErr('Introduce usuario y contraseña.'); return; }

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Verificando...';
  err.style.display = 'none';

  try {
    const res  = await fetch('/api/auth/login', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      credentials:'same-origin',
      body: JSON.stringify({username:u, password:p})
    });
    let data = {};
    try { data = await res.json(); } catch(_) {}
    if (!res.ok) throw new Error(data.error || 'Error de autenticación.');
    if (data.needsTotp) {
      // Mostrar el paso 2 de TOTP
      showTotpStep();
      return;
    }
    window.location.href = '/';
  } catch(e) {
    showErr(e.message);
    btn.disabled = false;
    btn.textContent = 'Entrar';
    document.getElementById('password').value = '';
    document.getElementById('password').focus();
  }
}

function showTotpStep() {
  // Ocultar campos de password y mostrar el campo TOTP
  document.getElementById('loginStep').style.display = 'none';
  document.getElementById('totpStep').style.display  = 'block';
  setTimeout(() => document.getElementById('totpCode')?.focus(), 50);
}

async function doTotp() {
  const btn  = document.getElementById('btnTotp');
  const code = (document.getElementById('totpCode').value || '').trim();
  if (!/^\d{6}$/.test(code)) { showErr('Introduce el código de 6 dígitos.'); return; }

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Verificando...';
  document.getElementById('errorBox').style.display = 'none';

  try {
    const headers = { 'Content-Type':'application/json' };
    const csrf = readCookie('csrf');
    if (csrf) headers['X-CSRF-Token'] = csrf;
    const res = await fetch('/api/auth/login-totp', {
      method:'POST', headers, credentials:'same-origin',
      body: JSON.stringify({ code })
    });
    let data = {};
    try { data = await res.json(); } catch(_) {}
    if (!res.ok) throw new Error(data.error || 'Código incorrecto.');
    window.location.href = '/';
  } catch(e) {
    showErr(e.message);
    btn.disabled = false;
    btn.textContent = 'Verificar';
    document.getElementById('totpCode').value = '';
    document.getElementById('totpCode').focus();
  }
}

function showErr(msg) {
  const el = document.getElementById('errorBox');
  el.textContent = msg;
  el.style.display = 'block';
}
