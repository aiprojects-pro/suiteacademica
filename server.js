require('dotenv').config();
const express   = require('express');
const session   = require('express-session');
const SqliteStore = require('better-sqlite3-session-store')(session);
const Database  = require('better-sqlite3');
const bcrypt    = require('bcrypt');
const multer    = require('multer');
// mammoth y unpdf se cargan en el worker (workers/parser-worker.js), NO en el proceso
// principal: parsear documentos en el main puede tumbar el event loop con un PDF
// malicioso o agotar memoria.
const Anthropic = require('@anthropic-ai/sdk');
const JSZip     = require('jszip');
const { v4: uuidv4 } = require('uuid');
const path      = require('path');
const fs        = require('fs');
const crypto    = require('crypto');
const helmet    = require('helmet');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const dns       = require('dns').promises;
const net       = require('net');
const { Worker } = require('worker_threads');
const otplib = require('otplib');
const QRCode = require('qrcode');

// otplib v13 expone funciones top-level: generateSecret, generateURI, verify (async).
// verify() devuelve { valid: boolean, ... } — NO un booleano. Extraemos .valid explícitamente.
// Tolerancia de ±1 step para evitar problemas de reloj entre cliente y servidor.
async function totpVerify(token, secret) {
  try {
    const r = await otplib.verify({ token, secret, window: 1 });
    return !!(r && r.valid);
  } catch (_) { return false; }
}
function totpGenerateSecret() { return otplib.generateSecret(); }
function totpUri(account, issuer, secret) { return otplib.generateURI({ account, issuer, secret }); }

// Backup codes: 10 códigos de un solo uso, formato XXXX-XXXX (8 chars alfanuméricos en mayúsculas).
// Se devuelven en texto plano UNA vez al activar 2FA; en disco sólo guardamos hashes bcrypt.
function generateBackupCodes(n = 10) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin 0/O/1/I para evitar confusión
  const codes = [];
  for (let i = 0; i < n; i++) {
    const bytes = crypto.randomBytes(8);
    let raw = '';
    for (const b of bytes) raw += alphabet[b % alphabet.length];
    codes.push(raw.slice(0, 4) + '-' + raw.slice(4));
  }
  return codes;
}
async function hashBackupCodes(codes) {
  return Promise.all(codes.map(c => bcrypt.hash(c, 10)));
}
// Devuelve el índice del backup code que coincide, o -1.
async function findMatchingBackupCode(code, hashes) {
  if (!Array.isArray(hashes) || !hashes.length) return -1;
  const normalized = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (normalized.length !== 8) return -1;
  const formatted = normalized.slice(0, 4) + '-' + normalized.slice(4);
  for (let i = 0; i < hashes.length; i++) {
    try {
      if (await bcrypt.compare(formatted, hashes[i])) return i;
    } catch (_) {}
  }
  return -1;
}

const {
  Document, Packer, Paragraph, TextRun, ImageRun, HeadingLevel,
  AlignmentType, BorderStyle, Header, Footer, PageNumber, LevelFormat,
  Table, TableRow, TableCell, WidthType, ShadingType
} = require('docx');

// ── Validaciones de entorno ───────────────────────────────────────────────────
const MISSING = ['ANTHROPIC_API_KEY','SESSION_SECRET'].filter(k=>!process.env[k]);
if (MISSING.length) {
  console.error(`\n❌  Variables de entorno no definidas en .env: ${MISSING.join(', ')}`);
  console.error('    Copia .env.example como .env y completa los valores.\n');
  process.exit(1);
}

// Rechazar SESSION_SECRET débil o el placeholder del .env.example
const WEAK_SECRETS = new Set([
  'cambia-esto-por-una-cadena-aleatoria-larga-y-segura',
  'changeme', 'secret', 'session-secret'
]);
if (process.env.SESSION_SECRET.length < 32 || WEAK_SECRETS.has(process.env.SESSION_SECRET)) {
  console.error('\n❌  SESSION_SECRET es demasiado débil o es el placeholder por defecto.');
  console.error('    Debe tener al menos 32 caracteres aleatorios. Genera uno con:');
  console.error('    node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64\'))"\n');
  process.exit(1);
}

// ── Configuración ─────────────────────────────────────────────────────────────
const app  = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT  || 3000;
const HOST = process.env.HOST  || '127.0.0.1';
const MODEL       = process.env.ANTHROPIC_MODEL  || 'claude-sonnet-4-6';
const MAX_TOPICS  = parseInt(process.env.MAX_TOPICS  || '100');
const MAX_FILE_MB = parseInt(process.env.MAX_FILE_MB || '50');
const BATCH_SIZE  = parseInt(process.env.BATCH_SIZE  || '25');
const MAX_CHARS   = parseInt(process.env.MAX_CHARS   || '12000');
const MAQ_CHUNK   = parseInt(process.env.MAQ_CHUNK_CHARS || '18000'); // tamaño de chunk para maquetación
const MAQ_SINGLE  = parseInt(process.env.MAQ_SINGLE_CHARS || '18000'); // umbral para llamada única
// max_tokens para la maquetación. Por defecto 16000 (lo aceptan todos los modelos
// claude-sonnet 4.x sin headers beta). Si tu modelo soporta más y quieres dar margen
// para chunks grandes, subir vía env: MAQ_MAX_TOKENS=32000 (puede requerir header beta).
const MAQ_MAX_TOKENS = parseInt(process.env.MAQ_MAX_TOKENS || '16000');
const CACHE_TTL   = parseInt(process.env.CACHE_TTL_H || '4') * 3600000;
const SESSION_MS  = parseInt(process.env.SESSION_HOURS || '8') * 3600000;
const HISTORY_LIMIT = parseInt(process.env.HISTORY_LIMIT || '200');
const REQUIRE_TOTP_FOR_ADMINS = process.env.REQUIRE_TOTP_FOR_ADMINS === 'true';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Almacenamiento (users + historial + plantillas) ────────────────────────────
// DATA_DIR configurable por env (p.ej. en OKD el PVC se monta en /app/data o /data)
const DATA_DIR        = process.env.DATA_DIR || path.join(__dirname, 'data');
const USERS_FILE      = path.join(DATA_DIR, 'users.json');
const HISTORY_DIR     = path.join(DATA_DIR, 'history');
const TEMPLATES_DIR   = path.join(DATA_DIR, 'templates');
const SESSIONS_DIR    = path.join(DATA_DIR, 'sessions');
function ensurePrivateDir(p) {
  try {
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true, mode: 0o700 });
  } catch (e) {
    // En entornos containerizados (OKD/OpenShift) el volumen montado puede tener
    // un propietario distinto; si no podemos crear, asumimos que ya existe vía PVC.
    if (!fs.existsSync(p)) throw e;
  }
  // chmod tolerante: en OKD el PVC puede tener fsGroup y no podemos modificar permisos.
  try { fs.chmodSync(p, 0o700); } catch(_) {}
}
ensurePrivateDir(DATA_DIR);
ensurePrivateDir(HISTORY_DIR);
ensurePrivateDir(TEMPLATES_DIR);
ensurePrivateDir(SESSIONS_DIR);

// Escritura atómica con permisos restrictivos (0600).
function writePrivateJson(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch(_) {}
  fs.renameSync(tmp, file);
}

function loadUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch(_) { return []; }
}
function saveUsers(users) {
  writePrivateJson(USERS_FILE, users);
}
// Búsqueda consistente: por id o por username (siempre comparando con username.toLowerCase()).
function findUser(idOrUsername) {
  if (typeof idOrUsername !== 'string') return null;
  const needle = idOrUsername.toLowerCase();
  const users = loadUsers();
  return users.find(u => u.id === idOrUsername || (u.username && u.username.toLowerCase() === needle)) || null;
}

// ── Log de auditoría (JSON-line append-only con rotación simple) ──────────────
const AUDIT_FILE = path.join(DATA_DIR, 'audit.log');
const AUDIT_MAX_BYTES = parseInt(process.env.AUDIT_MAX_BYTES || (5 * 1024 * 1024));
function rotateAuditIfNeeded() {
  try {
    const st = fs.statSync(AUDIT_FILE);
    if (st.size < AUDIT_MAX_BYTES) return;
    const rotated = AUDIT_FILE + '.1';
    try { fs.unlinkSync(rotated); } catch(_) {}
    fs.renameSync(AUDIT_FILE, rotated);
    try { fs.chmodSync(rotated, 0o600); } catch(_) {}
  } catch(_) { /* fichero no existe o no rotable */ }
}

// Monitoring en memoria de eventos sensibles para alertar si se concentran.
// Ventana deslizante simple: array de timestamps, descartamos los antiguos al añadir.
const SENSITIVE_EVENTS = new Set(['login_fail', 'login_locked', 'login_totp_fail']);
const MONITOR_WINDOW_MS = parseInt(process.env.MONITOR_WINDOW_MS || (5 * 60 * 1000)); // 5 min
const MONITOR_THRESHOLD = parseInt(process.env.MONITOR_THRESHOLD || '20');
const monitorBuffer = [];
let lastMonitorAlert = 0;
function monitorEvent(event) {
  if (!SENSITIVE_EVENTS.has(event)) return;
  const now = Date.now();
  monitorBuffer.push(now);
  // Descartar timestamps fuera de ventana
  while (monitorBuffer.length && monitorBuffer[0] < now - MONITOR_WINDOW_MS) monitorBuffer.shift();
  if (monitorBuffer.length >= MONITOR_THRESHOLD && (now - lastMonitorAlert) > MONITOR_WINDOW_MS) {
    lastMonitorAlert = now;
    console.warn(`\n⚠  [SECURITY] ${monitorBuffer.length} eventos sensibles en los últimos ${Math.round(MONITOR_WINDOW_MS/60000)} min — posible ataque. Revisa data/audit.log\n`);
  }
}

function audit(event, req, extra = {}) {
  try {
    rotateAuditIfNeeded();
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      event,
      ip: (req && (req.ip || req.connection?.remoteAddress)) || null,
      ua: req?.headers?.['user-agent']?.substring(0, 200) || null,
      actor: req?.user?.username || req?.session?.userId || null,
      ...extra
    }) + '\n';
    fs.appendFileSync(AUDIT_FILE, line, { mode: 0o600 });
    // Asegurar permisos (sólo cambia si el fichero existía con permisos laxos)
    try { fs.chmodSync(AUDIT_FILE, 0o600); } catch(_) {}
  } catch(e) {
    // No queremos que un fallo de logging tumbe la app
    console.warn('[audit] error:', e.message);
  }
  monitorEvent(event);
}

// ── Historial por usuario ─────────────────────────────────────────────────────
function historyPath(uid){ return path.join(HISTORY_DIR, `${uid}.json`); }
function loadHistory(uid){
  try { return JSON.parse(fs.readFileSync(historyPath(uid), 'utf8')); } catch(_) { return []; }
}
function saveHistory(uid, list){
  writePrivateJson(historyPath(uid), list);
}
function addHistoryEntry(uid, entry){
  const list = loadHistory(uid);
  const full = { id: uuidv4(), userId: uid, createdAt: new Date().toISOString(), ...entry };
  list.unshift(full);
  // conservar solo los más recientes
  const trimmed = list.slice(0, HISTORY_LIMIT);
  saveHistory(uid, trimmed);
  return full;
}

// ── Plantillas de color por usuario ───────────────────────────────────────────
function templatesPath(uid){ return path.join(TEMPLATES_DIR, `${uid}.json`); }
function loadTemplates(uid){
  try { return JSON.parse(fs.readFileSync(templatesPath(uid), 'utf8')); } catch(_) { return null; }
}
function saveTemplates(uid, list){
  writePrivateJson(templatesPath(uid), list);
}

// Plantillas por defecto si el usuario no tiene ninguna
const DEFAULT_TEMPLATES = [
  {
    id: 'default-scormxpress',
    name: 'SCORMXPRESS Clásico',
    builtin: true,
    colors: { h1:'B35C00', h2:'1F4E79', h3:'404040', lineH1:'E8A000', lineH2:'AEC6E0', title:'1F4E79', body:'1a1917', header:'8f8d88', brd:'D0CEC8' }
  },
  {
    id: 'default-corporate-blue',
    name: 'Corporativo Azul',
    builtin: true,
    colors: { h1:'0B5394', h2:'1F4E79', h3:'3D5C7A', lineH1:'85B7EB', lineH2:'B8D4F0', title:'0B3A68', body:'1a1917', header:'6F7D8C', brd:'D0CEC8' }
  },
  {
    id: 'default-corporate-green',
    name: 'Corporativo Verde',
    builtin: true,
    colors: { h1:'085041', h2:'1D9E75', h3:'3D5C4A', lineH1:'9FE1CB', lineH2:'C8EBDE', title:'085041', body:'1a1917', header:'6F7D78', brd:'D0CEC8' }
  },
  {
    id: 'default-elegant-gray',
    name: 'Elegante Neutro',
    builtin: true,
    colors: { h1:'2C2C2C', h2:'555555', h3:'777777', lineH1:'B5B5B5', lineH2:'DDDDDD', title:'1a1917', body:'1a1917', header:'8f8d88', brd:'D0CEC8' }
  }
];

function getUserTemplates(uid){
  const stored = loadTemplates(uid);
  if (stored && Array.isArray(stored)) return [...DEFAULT_TEMPLATES, ...stored];
  return [...DEFAULT_TEMPLATES];
}

// ── Crear admin por defecto en el primer arranque ─────────────────────────────
async function initUsers() {
  const users = loadUsers();
  if (users.length === 0) {
    const adminUser = (process.env.ADMIN_USER || 'admin').toLowerCase();
    // Si no se define ADMIN_PASS se genera una aleatoria de 24 bytes (32 chars base64url).
    // En cualquier caso, se exige cambio en el primer login y NUNCA se imprime en stdout.
    const adminPassGenerated = !process.env.ADMIN_PASS;
    const adminPass = process.env.ADMIN_PASS || crypto.randomBytes(24).toString('base64url');
    const hash = await bcrypt.hash(adminPass, 12);
    saveUsers([{
      id:        uuidv4(),
      username:  adminUser,
      name:      'Administrador',
      password:  hash,
      role:      'admin',
      active:    true,
      mustChangePassword: true,
      createdAt: new Date().toISOString(),
      lastLogin: null
    }]);
    if (adminPassGenerated) {
      // Sólo cuando NO se ha proporcionado ADMIN_PASS escribimos la contraseña a un
      // fichero con permisos 600 que el operador debe leer una sola vez y borrar.
      const onceFile = path.join(DATA_DIR, 'ADMIN_INITIAL_PASSWORD.txt');
      fs.writeFileSync(onceFile, adminPass + '\n', { mode: 0o600 });
      try { fs.chmodSync(onceFile, 0o600); } catch(_) {}
      console.log(`\n🔑  Usuario administrador creado: ${adminUser}`);
      console.log(`     Contraseña inicial en: ${onceFile}`);
      console.log(`     ⚠  El sistema EXIGE cambiarla en el primer login. Borra el fichero después.\n`);
    } else {
      console.log(`\n🔑  Usuario administrador creado: ${adminUser}`);
      console.log(`     ⚠  El sistema EXIGE cambio de contraseña en el primer login.\n`);
    }
  }
}

// ── Cache de temas (aislado por userId + cuota por usuario) ───────────────────
const topicCache = new Map();
const USER_TOPIC_BUDGET_BYTES = parseInt(process.env.USER_TOPIC_BUDGET_MB || '250') * 1024 * 1024;

// Estima el tamaño en bytes que ocupa un topic en memoria (aproximado).
function estimateTopicBytes(topic) {
  let n = 0;
  if (topic.base64)  n += topic.base64.length;
  if (topic.text)    n += topic.text.length * 2; // UTF-16 en V8
  if (Array.isArray(topic.images)) for (const im of topic.images) n += im.data?.length || 0;
  if (Array.isArray(topic.tables)) for (const tb of topic.tables) n += JSON.stringify(tb).length;
  return n;
}

// Inserta un topic en el cache asociado al usuario, expulsando los más antiguos del MISMO usuario
// si supera la cuota. Nunca toca topics de otros usuarios.
function addToTopicCache(userId, id, topic) {
  // Defensa crítica: si userId es falsy (undefined/null), NO almacenamos el topic.
  // De lo contrario, dos peticiones sin user válido podrían compartir cache.
  if (!userId || typeof userId !== 'string') {
    throw new Error('addToTopicCache: userId obligatorio');
  }
  const bytes = estimateTopicBytes(topic);
  // Si un solo topic supera el budget completo, rechazamos antes de caer en
  // memoria. Mejor un 413 al cliente que un OOM diferido del proceso.
  if (bytes > USER_TOPIC_BUDGET_BYTES) {
    throw new Error(`Documento demasiado grande para el cache (${Math.round(bytes/1024/1024)} MB > ${Math.round(USER_TOPIC_BUDGET_BYTES/1024/1024)} MB).`);
  }
  topicCache.set(id, { ...topic, ts: Date.now(), userId, bytes });
  let total = 0;
  const owned = [];
  for (const [tid, t] of topicCache) {
    if (t.userId === userId) { total += t.bytes || 0; owned.push([tid, t]); }
  }
  if (total <= USER_TOPIC_BUDGET_BYTES) return;
  owned.sort((a, b) => a[1].ts - b[1].ts); // más antiguo primero
  for (const [tid, t] of owned) {
    if (total <= USER_TOPIC_BUDGET_BYTES) break;
    if (tid === id) continue; // no expulsar el recién añadido
    topicCache.delete(tid);
    total -= t.bytes || 0;
  }
}

// `.unref()` para que el timer no impida un shutdown gracioso (SIGTERM).
setInterval(() => { const n=Date.now(); for(const[id,e] of topicCache) if(n-e.ts>CACHE_TTL) topicCache.delete(id); }, 3600000).unref();

// Devuelve el topic SOLO si pertenece al usuario que hace la petición.
// Defensa crítica: rechazar si cualquiera de los dos userId es falsy (evita
// `undefined === undefined` permitiendo acceso cruzado sin sesión válida).
function getOwnedTopic(req, id) {
  if (typeof id !== 'string' || id.length < 8) return null;
  const t = topicCache.get(id);
  if (!t) return null;
  const reqUid = req.user?.id;
  if (!reqUid || !t.userId || t.userId !== reqUid) return null;
  return t;
}

// ── Middleware ────────────────────────────────────────────────────────────────
// Helmet con CSP estricta:
// - script-src 'self' (sin unsafe-inline) → bloquea <script>inyectado</script>.
// - script-src-attr 'unsafe-inline' → permite los onclick="..." legítimos del HTML.
//   (Mitigación parcial: cualquier inyección de etiqueta <script> sigue bloqueada.)
// - style-src 'self' 'unsafe-inline' → estilos inline siguen permitidos (riesgo bajo).
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      defaultSrc:     ["'self'"],
      scriptSrc:      ["'self'"],
      scriptSrcAttr:  ["'unsafe-inline'"],
      styleSrc:       ["'self'", "'unsafe-inline'"],
      imgSrc:         ["'self'", 'data:', 'blob:'],
      connectSrc:     ["'self'"],
      fontSrc:        ["'self'", 'data:'],
      objectSrc:      ["'none'"],
      frameAncestors: ["'self'"],
      baseUri:        ["'self'"],
      formAction:     ["'self'"]
    }
  },
  crossOriginEmbedderPolicy: false,
  hsts: process.env.HTTPS === 'true' ? undefined : false
}));
// Bodies pequeños por defecto. Los uploads grandes van por multer y NO usan estos parsers.
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
// SQLite session store (más robusto bajo concurrencia que ficheros sueltos).
// La base se crea con permisos 0600 vía writePrivateJson-like wrapping de fs.chmodSync.
const SESSION_DB = path.join(SESSIONS_DIR, 'sessions.sqlite');
const sessionDb = new Database(SESSION_DB);
try { fs.chmodSync(SESSION_DB, 0o600); } catch(_) {}
app.use(session({
  name:              'sid',
  store:             new SqliteStore({
    client: sessionDb,
    expired: { clear: true, intervalMs: 15 * 60 * 1000 }
  }),
  secret:            process.env.SESSION_SECRET,
  resave:            false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'strict',
    secure:   process.env.NODE_ENV === 'production' && process.env.HTTPS === 'true',
    maxAge:   SESSION_MS
  }
}));

// Redirección HTTP→HTTPS si HTTPS=true y hay reverse proxy
if (process.env.HTTPS === 'true') {
  app.use((req, res, next) => {
    if (req.secure || req.headers['x-forwarded-proto'] === 'https') return next();
    if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(403).json({ error: 'HTTPS requerido.' });
    return res.redirect(308, 'https://' + req.headers.host + req.originalUrl);
  });
}

// ── CSRF doble-submit ─────────────────────────────────────────────────────────
// El servidor emite cookie 'csrf' (no httpOnly, sameSite:strict) con un token aleatorio.
// El frontend lee la cookie y la envía en cabecera 'X-CSRF-Token' en cada mutación.
// El servidor compara cookie == header con timingSafeEqual.
const CSRF_COOKIE_OPTS = {
  httpOnly: false,            // el JS necesita leerla
  sameSite: 'strict',
  secure:   process.env.NODE_ENV === 'production' && process.env.HTTPS === 'true',
  path:     '/'
};
function setCsrfCookieIfMissing(req, res) {
  if (!req.cookies?.csrf && !readCookie(req, 'csrf')) {
    const token = crypto.randomBytes(32).toString('base64url');
    res.cookie('csrf', token, CSRF_COOKIE_OPTS);
    // Para que el header de la primera mutación funcione, exponemos el token también vía cabecera de respuesta
    res.setHeader('X-CSRF-Token', token);
  }
}
function readCookie(req, name) {
  const hdr = req.headers.cookie || '';
  for (const part of hdr.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}
const SAFE_METHODS  = new Set(['GET','HEAD','OPTIONS']);
const CSRF_EXEMPT   = new Set(['/api/auth/login']); // login no tiene sesión que confundir
function csrfProtect(req, res, next) {
  // Siempre asegura que la cookie esté establecida para futuras peticiones
  setCsrfCookieIfMissing(req, res);
  if (SAFE_METHODS.has(req.method) || CSRF_EXEMPT.has(req.path)) return next();
  const cookieTok = readCookie(req, 'csrf');
  const headerTok = req.headers['x-csrf-token'];
  if (!cookieTok || !headerTok || cookieTok.length !== headerTok.length) {
    return res.status(403).json({ error: 'CSRF token inválido o ausente.' });
  }
  try {
    const a = Buffer.from(cookieTok);
    const b = Buffer.from(headerTok);
    if (!crypto.timingSafeEqual(a, b)) {
      return res.status(403).json({ error: 'CSRF token inválido.' });
    }
  } catch(_) {
    return res.status(403).json({ error: 'CSRF token inválido.' });
  }
  next();
}
app.use(csrfProtect);

// ── Rate limiters ─────────────────────────────────────────────────────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,                       // 10 intentos por IP cada 15 min
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de inicio de sesión. Inténtalo más tarde.' }
});
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,                      // 120 req/min global por IP en /api/*
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path.startsWith('/api/auth/login'),
  message: { error: 'Demasiadas peticiones. Espera unos segundos.' }
});
const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,                       // 20 req/min por sesión a endpoints IA
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => req.session?.userId || ipKeyGenerator(req, res),
  message: { error: 'Límite de uso de IA por minuto alcanzado. Espera un poco.' }
});
app.use('/api', apiLimiter);

// Lockout por usuario tras varios fallos de login (en memoria + persistencia ligera)
const LOGIN_FAIL_FILE  = path.join(DATA_DIR, 'login-fails.json');
const LOCKOUT_THRESHOLD = 8;
const LOCKOUT_MS        = 30 * 60 * 1000;
function loadLoginFails() {
  try { return JSON.parse(fs.readFileSync(LOGIN_FAIL_FILE, 'utf8')); } catch(_) { return {}; }
}
function saveLoginFails(o) {
  try { fs.writeFileSync(LOGIN_FAIL_FILE, JSON.stringify(o), { mode: 0o600 }); } catch(_) {}
}
function recordLoginFail(username) {
  const o = loadLoginFails();
  const e = o[username] || { count: 0, lockUntil: 0 };
  e.count += 1;
  e.lastFail = Date.now();
  if (e.count >= LOCKOUT_THRESHOLD) {
    e.lockUntil = Date.now() + LOCKOUT_MS;
    e.count = 0;
  }
  o[username] = e;
  saveLoginFails(o);
}
function clearLoginFail(username) {
  const o = loadLoginFails();
  if (o[username]) { delete o[username]; saveLoginFails(o); }
}
function isLockedOut(username) {
  const o = loadLoginFails();
  const e = o[username];
  return !!(e && e.lockUntil && e.lockUntil > Date.now());
}

app.use((_req,res,next) => { res.setHeader('Referrer-Policy','no-referrer'); next(); });

// ── Auth helpers ──────────────────────────────────────────────────────────────
// Rutas exentas del bloqueo por mustChangePassword (necesarias para poder cambiarla)
const PASSWORD_GRACE_PATHS = new Set([
  '/api/auth/me',
  '/api/auth/logout',
  '/api/auth/change-password'
]);
// Rutas exentas del bloqueo por TOTP obligatorio: las que necesita un admin para activarlo
// y para cambiar su contraseña si está en el primer login.
const TOTP_GRACE_PATHS = new Set([
  '/api/auth/me',
  '/api/auth/logout',
  '/api/auth/change-password',
  '/api/auth/totp/setup',
  '/api/auth/totp/enable'
]);

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    const isJson = req.headers['content-type']?.includes('json') || req.xhr;
    return isJson
      ? res.status(401).json({ error:'No autenticado', redirect:'/login' })
      : res.redirect('/login');
  }
  const user = findUser(req.session.userId);
  if (!user || !user.active) {
    req.session.destroy((err) => { if (err) console.warn('[session] destroy error:', err.message); });
    return res.redirect('/login?msg=session_expired');
  }
  req.user = user;
  // Helper: permite GETs a assets estáticos (HTML, JS, CSS, fuentes, imágenes) para
  // que la SPA cargue correctamente aun bajo bloqueo de mustChange / mustEnable2FA.
  const isAssetGet = req.method === 'GET' && (
    req.path === '/' ||
    req.path === '/index.html' ||
    req.path === '/app.js' ||
    /\.(css|js|woff2?|ttf|otf|png|jpg|jpeg|gif|svg|ico|webp)$/i.test(req.path)
  );

  // Si el usuario debe cambiar la contraseña, sólo permitimos las rutas mínimas
  if (user.mustChangePassword && !PASSWORD_GRACE_PATHS.has(req.path)) {
    if (isAssetGet) return next();
    return res.status(403).json({ error: 'Debes cambiar la contraseña antes de continuar.', mustChangePassword: true });
  }
  // Si REQUIRE_TOTP_FOR_ADMINS y es admin sin 2FA, sólo permitimos rutas para activarlo
  if (REQUIRE_TOTP_FOR_ADMINS && user.role === 'admin' && !user.totpEnabled && !TOTP_GRACE_PATHS.has(req.path)) {
    if (isAssetGet) return next();
    return res.status(403).json({ error: 'Como administrador debes activar 2FA antes de continuar.', mustEnable2FA: true });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error:'Acceso denegado. Se requiere rol administrador.' });
  next();
}

// Hash bcrypt dummy con coste 12 para mantener tiempo constante cuando el usuario no existe
const DUMMY_HASH = '$2a$12$CwTycUXWue0Thq9StjUM0uJ8R8t0H1NaaP6XQpQp5J3eRk4yQ7c0a';

// ── Rutas de autenticación (sin protección) ────────────────────────────────────
app.get('/login', (req, res) => {
  if (req.session.userId) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// JS del login servido públicamente (necesario para que CSP estricta pueda cargarlo)
app.get('/login.js', (_req, res) => {
  res.type('application/javascript');
  res.sendFile(path.join(__dirname, 'public', 'login.js'));
});

app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    return res.status(400).json({ error:'Usuario y contraseña son obligatorios.' });
  }
  const uname = username.trim().toLowerCase();

  // Lockout por cuenta
  if (isLockedOut(uname)) {
    audit('login_locked', req, { username: uname });
    return res.status(429).json({ error:'Cuenta bloqueada temporalmente por demasiados intentos. Espera 30 minutos.' });
  }

  const user = findUser(uname);
  // Siempre ejecutar bcrypt.compare (contra hash dummy si no existe el usuario) para mitigar timing attacks
  const hashToCheck = user?.password || DUMMY_HASH;
  let ok = false;
  try { ok = await bcrypt.compare(password, hashToCheck); } catch(_) { ok = false; }

  if (!user || !ok) {
    recordLoginFail(uname);
    audit('login_fail', req, { username: uname, reason: user ? 'bad_password' : 'no_such_user' });
    return res.status(401).json({ error:'Usuario o contraseña incorrectos.' });
  }
  if (!user.active) {
    audit('login_fail', req, { username: uname, reason: 'disabled' });
    return res.status(403).json({ error:'Esta cuenta está desactivada. Contacta con el administrador.' });
  }

  clearLoginFail(uname);

  // Si el usuario tiene 2FA activado, NO iniciamos sesión todavía: pedimos el código TOTP.
  // Guardamos el id pendiente en la sesión como `pendingUserId` (sin `userId` aún).
  if (user.totpEnabled) {
    req.session.regenerate((err) => {
      if (err) {
        console.error('[auth] session.regenerate error:', err.message);
        return res.status(500).json({ error:'Error iniciando sesión.' });
      }
      req.session.pendingUserId = user.id;
      req.session.pendingSince  = Date.now();
      // Token CSRF también necesario para el segundo paso
      const csrfTok = crypto.randomBytes(32).toString('base64url');
      res.cookie('csrf', csrfTok, CSRF_COOKIE_OPTS);
      res.setHeader('X-CSRF-Token', csrfTok);
      req.session.save(() => {
        audit('login_step1_ok', req, { username: user.username });
        res.json({ success: false, needsTotp: true });
      });
    });
    return;
  }

  audit('login_ok', req, { username: user.username });

  // Regenerar sesión para prevenir session fixation
  req.session.regenerate((err) => {
    if (err) {
      console.error('[auth] session.regenerate error:', err.message);
      return res.status(500).json({ error:'Error iniciando sesión.' });
    }
    req.session.userId = user.id;
    // Emitir/rotar token CSRF tras login
    const csrfTok = crypto.randomBytes(32).toString('base64url');
    res.cookie('csrf', csrfTok, CSRF_COOKIE_OPTS);
    res.setHeader('X-CSRF-Token', csrfTok);
    req.session.save(() => {
      const users = loadUsers();
      const idx = users.findIndex(u => u.id === user.id);
      if (idx !== -1) { users[idx].lastLogin = new Date().toISOString(); saveUsers(users); }
      res.json({
        success: true,
        name: user.name,
        role: user.role,
        username: user.username,
        mustChangePassword: !!user.mustChangePassword
      });
    });
  });
});

// ── /api/auth/login-totp — segundo paso del login con código TOTP ─────────────
// Requiere CSRF (la cookie ya se emitió en el paso 1) y está sujeto al rate limiter
// de login para evitar fuerza bruta de códigos.
app.post('/api/auth/login-totp', loginLimiter, async (req, res) => {
  const { code } = req.body || {};
  if (typeof code !== 'string' || !code.trim()) {
    return res.status(400).json({ error:'Introduce un código.' });
  }
  const pendingId = req.session.pendingUserId;
  const since     = req.session.pendingSince;
  if (!pendingId || !since || (Date.now() - since) > 5 * 60 * 1000) {
    return res.status(401).json({ error:'No hay un inicio de sesión pendiente. Vuelve a introducir tus credenciales.' });
  }
  const user = findUser(pendingId);
  if (!user || !user.active || !user.totpEnabled || !user.totpSecret) {
    return res.status(401).json({ error:'No se pudo completar la autenticación.' });
  }

  const trimmed = code.trim();
  let usedBackup = false;
  let ok = /^\d{6}$/.test(trimmed) && await totpVerify(trimmed, user.totpSecret);

  if (!ok) {
    // Si no es un código TOTP válido, probar como backup code
    const matchIdx = await findMatchingBackupCode(trimmed, user.totpBackupCodes);
    if (matchIdx !== -1) {
      ok = true;
      usedBackup = true;
      // Consumir el código usado
      const users = loadUsers();
      const uidx = users.findIndex(u => u.id === user.id);
      if (uidx !== -1) {
        users[uidx].totpBackupCodes = (users[uidx].totpBackupCodes || []).filter((_, i) => i !== matchIdx);
        saveUsers(users);
      }
    }
  }

  if (!ok) {
    recordLoginFail(user.username);
    audit('login_totp_fail', req, { username: user.username });
    return res.status(401).json({ error:'Código incorrecto.' });
  }

  clearLoginFail(user.username);
  audit('login_ok', req, { username: user.username, totp: true, backup: usedBackup });

  req.session.regenerate((err) => {
    if (err) {
      console.error('[auth] session.regenerate error:', err.message);
      return res.status(500).json({ error:'Error iniciando sesión.' });
    }
    req.session.userId = user.id;
    const csrfTok = crypto.randomBytes(32).toString('base64url');
    res.cookie('csrf', csrfTok, CSRF_COOKIE_OPTS);
    res.setHeader('X-CSRF-Token', csrfTok);
    req.session.save(() => {
      const users = loadUsers();
      const idx = users.findIndex(u => u.id === user.id);
      if (idx !== -1) { users[idx].lastLogin = new Date().toISOString(); saveUsers(users); }
      res.json({
        success: true,
        name: user.name,
        role: user.role,
        username: user.username,
        mustChangePassword: !!user.mustChangePassword
      });
    });
  });
});

app.post('/api/auth/logout', (req, res) => {
  const actor = findUser(req.session.userId)?.username || req.session.userId || null;
  req.session.destroy((err) => {
    if (err) console.warn('[session] destroy error:', err.message);
    else audit('logout', req, { username: actor });
    res.clearCookie('sid');
    res.clearCookie('csrf');
    res.json({ success:true });
  });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  const { id, username, name, role, createdAt, lastLogin, mustChangePassword, totpEnabled, totpBackupCodes } = req.user;
  res.json({
    id, username, name, role, createdAt, lastLogin,
    mustChangePassword: !!mustChangePassword,
    totpEnabled: !!totpEnabled,
    backupCodesRemaining: Array.isArray(totpBackupCodes) ? totpBackupCodes.length : 0,
    requireTotpForAdmins: REQUIRE_TOTP_FOR_ADMINS
  });
});

// ── Rutas de administración de usuarios ────────────────────────────────────────
app.get('/api/admin/users', requireAuth, requireAdmin, (_req, res) => {
  const users = loadUsers().map(({ password: _p, ...u }) => u);
  res.json(users);
});

app.post('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  const { username, name, password, role } = req.body || {};
  if (typeof username !== 'string' || typeof name !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error:'Usuario, nombre y contraseña son obligatorios.' });
  }
  if (!username || !name) return res.status(400).json({ error:'Usuario y nombre son obligatorios.' });
  if (!/^[a-zA-Z0-9._-]{3,40}$/.test(username.trim())) {
    return res.status(400).json({ error:'Nombre de usuario inválido (3-40 caracteres alfanuméricos, ._-).' });
  }
  const strengthErr = validatePasswordStrength(password);
  if (strengthErr) return res.status(400).json({ error: strengthErr });

  const users = loadUsers();
  const slug = username.trim().toLowerCase();
  if (users.find(u => u.username.toLowerCase() === slug)) return res.status(409).json({ error:'Ese nombre de usuario ya existe.' });

  const hash = await bcrypt.hash(password, 12);
  const user = {
    id:uuidv4(), username:slug, name:name.trim().substring(0,80),
    password:hash, role: role === 'admin' ? 'admin' : 'user',
    active:true, mustChangePassword:true,
    createdAt:new Date().toISOString(), lastLogin:null
  };
  users.push(user);
  saveUsers(users);
  audit('user_create', req, { target: user.username, role: user.role });
  const { password: _p, ...safe } = user;
  res.json({ success:true, user:safe });
});

app.patch('/api/admin/users/:id', requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { name, role, active, password } = req.body;
  const users = loadUsers();
  const idx = users.findIndex(u => u.id === id);
  if (idx === -1) return res.status(404).json({ error:'Usuario no encontrado.' });

  if (id === req.user.id) {
    if (role && role !== 'admin') return res.status(400).json({ error:'No puedes cambiar tu propio rol.' });
    if (active === false) return res.status(400).json({ error:'No puedes desactivar tu propia cuenta.' });
  }

  if ((role && role !== 'admin') || active === false) {
    const adminsLeft = users.filter(u => u.role === 'admin' && u.active && u.id !== id).length;
    if (adminsLeft === 0) return res.status(400).json({ error:'Debe existir al menos un administrador activo.' });
  }

  if (typeof name === 'string' && name.trim()) users[idx].name = name.trim().substring(0,80);
  if (role)            users[idx].role   = role === 'admin' ? 'admin' : 'user';
  if (active !== undefined) users[idx].active = !!active;
  if (password) {
    const strengthErr = validatePasswordStrength(password);
    if (strengthErr) return res.status(400).json({ error: strengthErr });
    users[idx].password = await bcrypt.hash(password, 12);
    users[idx].mustChangePassword = true;
  }

  saveUsers(users);
  audit('user_update', req, { target: users[idx].username, changed: Object.keys(req.body || {}).filter(k => k !== 'password').concat(req.body?.password ? ['password'] : []) });
  const { password: _p, ...safe } = users[idx];
  res.json({ success:true, user:safe });
});

app.delete('/api/admin/users/:id', requireAuth, requireAdmin, (req, res) => {
  const { id } = req.params;
  if (id === req.user.id) return res.status(400).json({ error:'No puedes eliminar tu propia cuenta.' });
  const users = loadUsers();
  const target = users.find(u => u.id === id);
  if (!target) return res.status(404).json({ error:'Usuario no encontrado.' });

  const adminsLeft = users.filter(u => u.role === 'admin' && u.active && u.id !== id).length;
  if (target.role === 'admin' && adminsLeft === 0) return res.status(400).json({ error:'No puedes eliminar el único administrador activo.' });

  saveUsers(users.filter(u => u.id !== id));
  // Borrar también su historial y plantillas
  try { fs.unlinkSync(historyPath(id)); } catch(_){}
  try { fs.unlinkSync(templatesPath(id)); } catch(_){}
  audit('user_delete', req, { target: target.username });
  res.json({ success:true });
});

function validatePasswordStrength(pw) {
  if (typeof pw !== 'string' || pw.length < 12) return 'La contraseña debe tener al menos 12 caracteres.';
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter(r => r.test(pw)).length;
  if (classes < 3) return 'Usa al menos 3 de: minúsculas, mayúsculas, dígitos, símbolos.';
  return null;
}

app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (typeof currentPassword !== 'string' || typeof newPassword !== 'string' || !currentPassword || !newPassword) {
    return res.status(400).json({ error:'Introduce la contraseña actual y la nueva.' });
  }
  const strengthErr = validatePasswordStrength(newPassword);
  if (strengthErr) return res.status(400).json({ error: strengthErr });
  if (newPassword === currentPassword) return res.status(400).json({ error:'La nueva contraseña debe ser distinta.' });

  const users = loadUsers();
  const idx = users.findIndex(u => u.id === req.user.id);
  if (idx === -1) return res.status(404).json({ error:'Usuario no encontrado.' });
  const ok = await bcrypt.compare(currentPassword, users[idx].password);
  if (!ok) return res.status(401).json({ error:'La contraseña actual no es correcta.' });

  users[idx].password = await bcrypt.hash(newPassword, 12);
  users[idx].mustChangePassword = false;
  saveUsers(users);
  audit('password_change', req, { username: users[idx].username });

  // Logout global: invalidar TODAS las sesiones del usuario excepto la actual.
  // Recorremos las entradas de sessions.sqlite y borramos las que tienen userId == este,
  // salvo el sid actual (req.sessionID). Así, si alguien tenía sesión robada, queda fuera.
  try {
    const currentSid = req.sessionID;
    const rows = sessionDb.prepare('SELECT sid, sess FROM sessions').all();
    let invalidated = 0;
    for (const row of rows) {
      try {
        const s = JSON.parse(row.sess);
        if (s.userId === req.user.id && row.sid !== currentSid) {
          sessionDb.prepare('DELETE FROM sessions WHERE sid = ?').run(row.sid);
          invalidated++;
        }
      } catch(_) {}
    }
    if (invalidated) audit('sessions_revoked', req, { username: users[idx].username, count: invalidated });
  } catch (e) {
    console.warn('[change-password] session revoke error:', e.message);
  }

  // Regenerar también la sesión ACTUAL y rotar CSRF. Si un atacante hubiera robado
  // la cookie de sesión actual, queda fuera junto con todas las demás.
  const uid = req.user.id;
  req.session.regenerate((err) => {
    if (err) {
      console.warn('[change-password] regenerate error:', err.message);
      return res.json({ success:true });
    }
    req.session.userId = uid;
    const csrfTok = crypto.randomBytes(32).toString('base64url');
    res.cookie('csrf', csrfTok, CSRF_COOKIE_OPTS);
    res.setHeader('X-CSRF-Token', csrfTok);
    req.session.save(() => res.json({ success:true }));
  });
});

// ── 2FA TOTP ─────────────────────────────────────────────────────────────────
// /api/auth/totp/setup: genera un secreto temporal y devuelve QR + secreto en texto.
// El secreto SOLO queda persistido al confirmar con /api/auth/totp/enable.
app.post('/api/auth/totp/setup', requireAuth, async (req, res) => {
  if (req.user.totpEnabled) return res.status(400).json({ error:'2FA ya está activado en esta cuenta.' });
  try {
    const secret = totpGenerateSecret();
    const issuer = 'Suite Académica';
    const otpauth = totpUri(req.user.username, issuer, secret);
    const qrDataUrl = await QRCode.toDataURL(otpauth, { errorCorrectionLevel: 'M', width: 240 });
    // Guardamos el secreto en sesión (no en disco) hasta que el usuario lo confirme con un código.
    req.session.totpPending = { secret, issuedAt: Date.now() };
    req.session.save(() => {
      res.json({ success:true, secret, otpauth, qr: qrDataUrl });
    });
  } catch (e) {
    console.error('[totp/setup] error:', e.message);
    res.status(500).json({ error:'No se pudo iniciar el alta de 2FA.' });
  }
});

// /api/auth/totp/enable: confirma con un código válido y persiste el secreto.
app.post('/api/auth/totp/enable', requireAuth, async (req, res) => {
  const { code } = req.body || {};
  if (typeof code !== 'string' || !/^\d{6}$/.test(code.trim())) {
    return res.status(400).json({ error:'Código TOTP inválido (6 dígitos).' });
  }
  if (req.user.totpEnabled) return res.status(400).json({ error:'2FA ya está activado.' });
  const pending = req.session.totpPending;
  if (!pending || !pending.secret || (Date.now() - pending.issuedAt) > 10 * 60 * 1000) {
    return res.status(400).json({ error:'No hay un alta de 2FA en curso. Vuelve a empezar.' });
  }
  const ok = await totpVerify(code.trim(), pending.secret);
  if (!ok) {
    return res.status(401).json({ error:'Código incorrecto.' });
  }
  const users = loadUsers();
  const idx = users.findIndex(u => u.id === req.user.id);
  if (idx === -1) return res.status(404).json({ error:'Usuario no encontrado.' });
  // Generar y persistir 10 backup codes hasheados. Los códigos en plano se devuelven UNA vez.
  const backupCodes = generateBackupCodes(10);
  const backupHashes = await hashBackupCodes(backupCodes);
  users[idx].totpSecret = pending.secret;
  users[idx].totpEnabled = true;
  users[idx].totpEnrolledAt = new Date().toISOString();
  users[idx].totpBackupCodes = backupHashes;
  saveUsers(users);
  delete req.session.totpPending;
  audit('totp_enable', req, { username: req.user.username });
  res.json({ success:true, backupCodes });
});

// /api/auth/totp/disable: requiere password actual (y opcionalmente un código TOTP).
app.post('/api/auth/totp/disable', requireAuth, async (req, res) => {
  const { password } = req.body || {};
  if (typeof password !== 'string' || !password) {
    return res.status(400).json({ error:'Introduce tu contraseña actual.' });
  }
  if (!req.user.totpEnabled) return res.status(400).json({ error:'2FA no está activado.' });
  const users = loadUsers();
  const idx = users.findIndex(u => u.id === req.user.id);
  if (idx === -1) return res.status(404).json({ error:'Usuario no encontrado.' });
  const ok = await bcrypt.compare(password, users[idx].password);
  if (!ok) return res.status(401).json({ error:'Contraseña incorrecta.' });
  delete users[idx].totpSecret;
  users[idx].totpEnabled = false;
  delete users[idx].totpEnrolledAt;
  delete users[idx].totpBackupCodes;
  saveUsers(users);
  audit('totp_disable', req, { username: req.user.username });
  res.json({ success:true });
});

// Regenerar backup codes (requiere password). Invalida los anteriores.
app.post('/api/auth/totp/backup-codes/regenerate', requireAuth, async (req, res) => {
  const { password } = req.body || {};
  if (typeof password !== 'string' || !password) {
    return res.status(400).json({ error:'Introduce tu contraseña actual.' });
  }
  if (!req.user.totpEnabled) return res.status(400).json({ error:'2FA no está activado.' });
  const users = loadUsers();
  const idx = users.findIndex(u => u.id === req.user.id);
  if (idx === -1) return res.status(404).json({ error:'Usuario no encontrado.' });
  const ok = await bcrypt.compare(password, users[idx].password);
  if (!ok) return res.status(401).json({ error:'Contraseña incorrecta.' });
  const backupCodes = generateBackupCodes(10);
  users[idx].totpBackupCodes = await hashBackupCodes(backupCodes);
  saveUsers(users);
  audit('totp_backup_regen', req, { username: req.user.username });
  res.json({ success:true, backupCodes });
});

app.get('/api/health', (req, res) => {
  // Sin token: respuesta mínima (para health-checkers externos sin credenciales).
  const token = req.headers['x-health-token'];
  if (!process.env.HEALTH_TOKEN || token !== process.env.HEALTH_TOKEN) {
    return res.json({ status:'ok' });
  }
  // Con token correcto: métricas completas.
  let sessions = 0;
  try { sessions = sessionDb.prepare('SELECT COUNT(*) AS c FROM sessions').get()?.c || 0; } catch(_) {}
  const mem = process.memoryUsage();
  res.json({
    status: 'ok',
    version: '8.1.0',
    model: MODEL,
    uptimeSec: Math.round(process.uptime()),
    rssMB:   Math.round(mem.rss / 1024 / 1024),
    heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
    sessionsActive: sessions,
    users: loadUsers().length,
    pid: process.pid,
    nodeVersion: process.version
  });
});

// ── Aplicar auth a todo lo demás ──────────────────────────────────────────────
app.use(requireAuth);
app.use(express.static(path.join(__dirname, 'public')));

// ── Multer ────────────────────────────────────────────────────────────────────
// Mimetypes permitidos en la primera línea de defensa (segunda línea = firma mágica en /api/upload)
const ALLOWED_MIMETYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/octet-stream' // algunos navegadores envían esto para .docx
]);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_MB*1024*1024, files: MAX_TOPICS },
  fileFilter: (_req, file, cb) => {
    const okExt  = /\.(docx?|pdf)$/i.test(file.originalname);
    const okMime = ALLOWED_MIMETYPES.has((file.mimetype || '').toLowerCase());
    if (okExt && okMime) return cb(null, true);
    return cb(new Error('Tipo de archivo no permitido. Sólo PDF, DOC, DOCX.'));
  }
});

// Firma mágica del fichero — comprueba los primeros bytes antes de cualquier parsing.
// %PDF-  → PDF · PK\x03\x04 → ZIP (DOCX moderno) · D0CF11E0 → CFB (DOC antiguo y DOCX viejos)
function detectFileSignature(buf) {
  if (!buf || buf.length < 8) return null;
  if (buf.slice(0, 5).toString('ascii') === '%PDF-') return 'pdf';
  if (buf[0] === 0x50 && buf[1] === 0x4B && buf[2] === 0x03 && buf[3] === 0x04) return 'zip';
  if (buf[0] === 0xD0 && buf[1] === 0xCF && buf[2] === 0x11 && buf[3] === 0xE0) return 'cfb';
  return null;
}

const PARSE_TIMEOUT_MS  = parseInt(process.env.PARSE_TIMEOUT_MS || '30000');
const PARSE_MEM_LIMIT_MB = parseInt(process.env.PARSE_MEM_LIMIT_MB || '512');

// Lanza un worker para parsear el documento de forma aislada. El worker tiene
// resourceLimits (memoria), y la promesa del padre tiene timeout + kill.
// Si el worker excede memoria, Node lo termina y aquí cae a un reject limpio.
function parseInWorker(type, buffer) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      try { fn(value); } catch (_) {}
    };

    const w = new Worker(path.join(__dirname, 'workers', 'parser-worker.js'), {
      workerData: { type, buffer },
      resourceLimits: { maxOldGenerationSizeMb: PARSE_MEM_LIMIT_MB }
    });
    const killTimer = setTimeout(() => {
      finish(reject, new Error(`worker ${type}: tiempo agotado`));
      w.terminate().catch(() => {});
    }, PARSE_TIMEOUT_MS);

    w.once('message', (msg) => {
      if (msg && msg.ok) finish(resolve, msg.data);
      else finish(reject, new Error((msg && msg.error) || 'worker: error desconocido'));
      // Tras settle, terminamos el worker. El evento `exit` posterior verá settled=true y no hará nada.
      w.terminate().catch(() => {});
    });
    w.once('error', (err) => finish(reject, err));
    w.once('exit', (code) => {
      // Si el worker terminó sin haber enviado message (memory limit, kill externo...),
      // settled aún es false y caemos aquí. Tras un `message` OK, settled ya es true y `finish` no hace nada.
      if (code !== 0) finish(reject, new Error(`worker ${type}: terminado con código ${code}`));
      else finish(reject, new Error(`worker ${type}: terminado sin enviar resultado`));
    });
  });
}

// ── Helpers de Claude ─────────────────────────────────────────────────────────
const LETTERS = ['A','B','C','D','E'];
// Llamada a Claude con streaming. Es OBLIGATORIO usar streaming porque el SDK rechaza
// llamadas no-streaming (`messages.create`) cuando estima que pueden tardar >10 min
// ("Streaming is strongly recommended for operations that may take longer than 10 minutes").
//
// Iteramos los eventos del stream explícitamente para:
//   - poder logear inicio/fin/errores con timing concreto
//   - opcionalmente invocar onTick() para mantener viva una conexión SSE del cliente
//     (evita que el router HAProxy de OKD corte la conexión por idle timeout)
async function callClaude(messages, maxTokens = 8000, onTick = null) {
  const t0 = Date.now();
  const reqId = Math.random().toString(36).slice(2, 8);
  let text = '';
  let inputTokens = 0, outputTokens = 0;
  let stream;
  try {
    console.log(`[claude ${reqId}] start model=${MODEL} max_tokens=${maxTokens}`);
    stream = anthropic.messages.stream({ model: MODEL, max_tokens: maxTokens, messages });

    let lastTick = Date.now();
    let chars = 0;
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        text += event.delta.text;
        chars = text.length;
        if (onTick && (Date.now() - lastTick) > 5000) {
          try { onTick(chars); } catch (_) {}
          lastTick = Date.now();
        }
      } else if (event.type === 'message_start') {
        inputTokens = event.message?.usage?.input_tokens || 0;
      } else if (event.type === 'message_delta') {
        outputTokens = event.usage?.output_tokens || outputTokens;
      } else if (event.type === 'error') {
        const t = event.error?.type ? `${event.error.type}: ` : '';
        throw new Error(t + (event.error?.message || 'stream error'));
      }
    }
    const ms = Date.now() - t0;
    console.log(`[claude ${reqId}] done ms=${ms} in=${inputTokens} out=${outputTokens} chars=${chars}`);
    return text.trim();
  } catch (err) {
    const ms = Date.now() - t0;
    const status = err?.status || err?.response?.status || 'n/a';
    const apiErr = err?.error?.error?.message || err?.error?.message || err?.message || 'unknown';
    console.error(`[claude ${reqId}] FAIL ms=${ms} status=${status} err=${apiErr}`);
    throw new Error(`Claude API: ${status} ${apiErr.substring(0, 160)}`);
  } finally {
    // Abortar el stream para liberar el fetch subyacente y dejar de consumir tokens
    // si salimos por error o por cierre del cliente (req.on('close')).
    try { stream?.controller?.abort(); } catch (_) {}
  }
}
function makeMessages(prompt, topic, textOverride=null, opts = {}) {
  // textOverride permite pasar un chunk específico en lugar de todo el texto.
  // opts.fullText=true desactiva el truncado a MAX_CHARS (necesario para maquetación,
  // donde necesitamos preservar el contenido íntegro del documento).
  if (textOverride) {
    return [{ role:'user', content:`CONTENIDO DE "${topic.name}":\n---\n${textOverride}\n---\n\n${prompt}` }];
  }
  if (topic?.type==='pdf' && topic.base64 && (!topic.text || topic.text.length < MAQ_SINGLE)) {
    return [{ role:'user', content:[{type:'document',source:{type:'base64',media_type:'application/pdf',data:topic.base64}},{type:'text',text:prompt}]}];
  }
  const textToUse = topic.text
    ? (opts.fullText ? topic.text : topic.text.substring(0, MAX_CHARS))
    : '';
  return [{ role:'user', content:`CONTENIDO DE "${topic.name}":\n---\n${textToUse}\n---\n\n${prompt}` }];
}

// ── Helpers de formato / imágenes ─────────────────────────────────────────────
function getImgDimensions(buf, contentType) {
  try {
    if (contentType.includes('png') && buf.length > 24) {
      const w=buf.readUInt32BE(16), h=buf.readUInt32BE(20);
      if(w>0&&h>0&&w<8000&&h<8000){const s=w>500?500/w:1;return{width:Math.round(w*s),height:Math.round(h*s)};}
    }
    if ((contentType.includes('jpeg')||contentType.includes('jpg'))&&buf.length>10) {
      let i=2;
      while(i<buf.length-9){
        if(buf[i]===0xFF&&(buf[i+1]===0xC0||buf[i+1]===0xC2)){const h=buf.readUInt16BE(i+5),w=buf.readUInt16BE(i+7);if(w>0&&h>0&&w<8000&&h<8000){const s=w>500?500/w:1;return{width:Math.round(w*s),height:Math.round(h*s)};}}
        if(buf[i]===0xFF&&i+3<buf.length){i+=2+buf.readUInt16BE(i+2);}else i++;
      }
    }
  }catch(_){}
  return {width:460,height:280};
}
// Convierte HTML de mammoth a texto plano. Antes de aplanar:
//  - extrae cada <table>...</table> y la sustituye por un marcador __TABLE_N__,
//    devolviendo en `tables` la representación literal de la tabla en celdas.
//  - extrae los <img src="__IMG_N__"> respetando los marcadores ya inyectados.
function htmlToText(html, tables = []) {
  // 1. Extraer tablas y sustituir por marcadores
  const withMarkers = String(html).replace(/<table[\s\S]*?<\/table>/gi, (match) => {
    const idx = tables.length;
    // Convertir la tabla a una matriz de celdas de texto
    const rows = [];
    const rowRe = /<tr[\s\S]*?<\/tr>/gi;
    let rm;
    while ((rm = rowRe.exec(match)) !== null) {
      const cells = [];
      const cellRe = /<(t[hd])[^>]*>([\s\S]*?)<\/\1>/gi;
      let cm;
      while ((cm = cellRe.exec(rm[0])) !== null) {
        const cellText = cm[2]
          .replace(/<br\s*\/?>/gi, ' ')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
          .replace(/\s+/g, ' ').trim();
        cells.push(cellText);
      }
      if (cells.length) rows.push(cells);
    }
    if (rows.length) {
      tables.push({ rows });
      return `\n__TABLE_${idx}__\n`;
    }
    return ' ';
  });

  // 2. Aplanar el resto del HTML
  return withMarkers
    .replace(/<img[^>]*src="(__IMG_\d+__)"[^>]*/gi,'\n$1\n')
    .replace(/<br\s*\/?>/gi,'\n').replace(/<\/p>/gi,'\n').replace(/<\/h[1-6]>/gi,'\n').replace(/<\/li>/gi,'\n')
    .replace(/<[^>]+>/g,' ')
    .replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"')
    .replace(/[ \t]+/g,' ').replace(/\n{3,}/g,'\n\n').trim();
}
function imgType(mime){if(mime.includes('jpeg')||mime.includes('jpg'))return'jpg';if(mime.includes('png'))return'png';return'png';}

// ── Punto final: todo lo que suene a frase (párrafos y puntos de lista) ──────
function ensurePeriod(t){
  if (!t) return '';
  const s = t.trim();
  if (!s) return '';
  const last = s.slice(-1);
  // Si ya termina en un signo cerrado o dos puntos/punto y coma, respetar
  if (['.',':',';','?','!','…'].includes(last)) return s;
  // Si termina en paréntesis/cita, comprobar antes
  if ([')',']','»','"','”'].includes(last)) {
    const prev = s.slice(-2, -1);
    if (['.',':',';','?','!','…'].includes(prev)) return s;
    return s + '.';
  }
  return s + '.';
}
function isUpperH(line){const t=line.trim();if(t.length<3)return false;const lt=t.replace(/[^a-zA-ZáéíóúüñÁÉÍÓÚÜÑ]/g,'');if(lt.length<3)return false;return lt.replace(/[^A-ZÁÉÍÓÚÜÑ]/g,'').length/lt.length>0.82;}
function mkBrd(c,sz=4){return{style:BorderStyle.SINGLE,size:sz,color:c};}


// ── Word document helpers ─────────────────────────────────────────────────────
// Genera la config de `numbering` para el Document. Cada `ol` del cuerpo necesita
// su PROPIA reference para que la numeraci\u00f3n se reinicie a 1 (docx-js comparte
// el contador si dos listas usan la misma reference). El frontend marcar\u00e1 cada
// `ol` con un `_numRef` \u00fanico antes de invocar makeDoc.
function buildNumberingConfig(numberedListCount = 0) {
  const config = [
    {reference:'bullets',levels:[{level:0,format:LevelFormat.BULLET,text:'\u2022',alignment:AlignmentType.LEFT,style:{paragraph:{indent:{left:720,hanging:360}},run:{font:'Arial',size:22}}}]}
  ];
  for (let i = 0; i < Math.max(1, numberedListCount); i++) {
    config.push({
      reference: `numbers-${i}`,
      levels: [{level:0,format:LevelFormat.DECIMAL,text:'%1.',alignment:AlignmentType.LEFT,style:{paragraph:{indent:{left:720,hanging:360}},run:{font:'Arial',size:22}}}]
    });
  }
  return config;
}

function makeDoc(children, name, footerTxt, colorT, colorL, extra={}) {
  return new Document({
    numbering:{config: buildNumberingConfig(extra.numberedListCount)},
    styles:{default:{document:{run:{font:'Arial',size:22}}},paragraphStyles:[
      {id:'Heading1',name:'Heading 1',basedOn:'Normal',next:'Normal',quickFormat:true,run:{size:extra.h1Size||36,bold:true,font:'Arial',color:colorT},paragraph:{spacing:{before:0,after:360},outlineLevel:0}},
      {id:'Heading2',name:'Heading 2',basedOn:'Normal',next:'Normal',quickFormat:true,run:{size:extra.h2Size||26,bold:true,font:'Arial',color:extra.h2Color||'2E75B6'},paragraph:{spacing:{before:300,after:100},outlineLevel:1}},
      {id:'Heading3',name:'Heading 3',basedOn:'Normal',next:'Normal',quickFormat:true,run:{size:extra.h3Size||24,bold:true,font:'Arial',color:extra.h3Color||'404040'},paragraph:{spacing:{before:260,after:100},outlineLevel:2}}
    ]},
    sections:[{
      properties:{page:{size:{width:11906,height:16838},margin:{top:1440,right:1440,bottom:1440,left:1440}}},
      headers:{default:new Header({children:[new Paragraph({children:[new TextRun({text:`Suite Académica · ${name}`,font:'Arial',size:18,color:extra.headerColor||'8f8d88'})],border:{bottom:mkBrd(colorL,6)},spacing:{before:0,after:100}})]})},
      footers:{default:new Footer({children:[new Paragraph({
        children: footerTxt
          ? [new TextRun({text:`${footerTxt} · `,font:'Arial',size:16,color:extra.headerColor||'8f8d88'}),
             new TextRun({children:['Pág. ',PageNumber.CURRENT,' / ',PageNumber.TOTAL_PAGES],font:'Arial',size:16,color:extra.headerColor||'8f8d88'})]
          : [new TextRun({children:['Pág. ',PageNumber.CURRENT,' / ',PageNumber.TOTAL_PAGES],font:'Arial',size:16,color:extra.headerColor||'8f8d88'})],
        alignment:AlignmentType.RIGHT,
        border:{top:mkBrd(colorL,4)},
        spacing:{before:100,after:0}
      })]})},
      children
    }]
  });
}

function buildSummaryDoc(name, text) {
  const cn=name.replace(/\.[^.]+$/,''),CT='1F4E79',CL='AEC6E0';
  const children=[new Paragraph({heading:HeadingLevel.HEADING_1,children:[new TextRun({text:cn,font:'Arial',size:36,bold:true,color:CT})],spacing:{before:0,after:360}})];
  for(const line of text.split('\n')){
    const t=line.trim();if(!t)continue;
    if(isUpperH(t)){
      children.push(new Paragraph({heading:HeadingLevel.HEADING_2,children:[new TextRun({text:t.endsWith('.')?t.slice(0,-1):t,font:'Arial',size:26,bold:true,color:'2E75B6'})],spacing:{before:300,after:100},border:{bottom:mkBrd(CL,6)}}));
    }else{
      children.push(new Paragraph({children:[new TextRun({text:ensurePeriod(t),font:'Arial',size:22})],spacing:{before:0,after:140},alignment:AlignmentType.JUSTIFIED}));
    }
  }
  return makeDoc(children,cn,'Resumen generado automáticamente',CT,CL);
}

// Quita marcadores de lista al inicio del texto. El modelo a veces incluye el
// prefijo "a)", "1.", "•", etc. EN el texto del item aunque ya lo marca como ul/ol.
// Sin esta limpieza, el documento muestra "• a) Texto" (doble viñeta) o "1. 1. Texto".
//
// CONSERVADOR: si tras quitar el marcador el texto restante es demasiado corto
// (< 4 chars significativos), NO lo quitamos: probablemente NO era un marcador,
// sino el texto completo (p.ej. un item legítimo cuyo contenido es solo "i)" como
// referencia interna). Mejor pecar de respetar el original que destruir texto.
function stripListMarker(s) {
  if (typeof s !== 'string') return s;
  const original = s.trim();
  let out = original;
  for (let i = 0; i < 3; i++) {
    const before = out;
    const candidate = out
      .replace(/^[•·▪◦●▶➤–\-*]\s+/, '')          // viñetas comunes
      .replace(/^\(?[a-zA-Z]\)\s+/, '')           // a)  (a)  b)  (b)
      .replace(/^[ivxlcdm]{1,5}\)\s+/i, '')       // i) ii) iii) iv)
      .replace(/^\d+\)\s+/, '')                   // 1) 2) 3)
      .replace(/^\d+\.\-?\s+/, '')                // 1.  1.-
      .replace(/^\d+[ºª]\.?\s+/, '')              // 1º 2º
      .replace(/^→\s+/, '');                      // → (flecha)
    // Si el strip dejó algo razonable (≥ 4 chars), lo aceptamos. Si no, paramos.
    if (candidate.length >= 4 && candidate !== before) out = candidate;
    else break;
  }
  return out;
}

// Asigna a cada bloque `ol` del documento una reference única para que la
// numeración reinicie a 1 en cada lista. Devuelve el número total de listas
// numeradas (para que `buildNumberingConfig` genere las references suficientes).
function assignNumberingRefs(blocks) {
  let count = 0;
  for (const b of blocks) {
    if (b && b.t === 'ol' && Array.isArray(b.items) && b.items.length) {
      b._numRef = `numbers-${count}`;
      count++;
    }
  }
  return count;
}

// ── Maquetación: Word con colores personalizables (plantilla) ─────────────────
function buildMaquetadoDoc(data, imageStore, tableStore, colors, quiz) {
  // Asignar references de numeración únicas por cada `ol` (problema: la
  // numeración continúa entre listas si comparten reference).
  const numberedListCount = assignNumberingRefs(data.blocks || []);

  // colors es un objeto de la plantilla aplicada
  const C = colors || DEFAULT_TEMPLATES[0].colors;
  const CH1 = C.h1, CH2 = C.h2, CH3 = C.h3;
  const CL1 = C.lineH1, CL2 = C.lineH2;
  const CTT = C.title || CH1;
  const CBD = C.brd || 'D0CEC8';
  const HDR = C.header || '8f8d88';

  // Título principal del documento como Heading 1 con punto al final.
  const docTitleText = ensurePeriod(String(data.title || 'Documento maquetado').trim());
  const children = [
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      children:[new TextRun({text: docTitleText, font:'Arial', size:40, bold:true, color:CTT})],
      spacing:{before:0, after:480},
      alignment:AlignmentType.CENTER,
      border:{bottom:{style:BorderStyle.SINGLE, size:8, color:CL1}}
    })
  ];

  // Generador del bloque "tabla comentada" que acompaña a cada tabla
  function addTable(tableIdx) {
    const tbl = tableStore && tableStore[tableIdx];
    if (!tbl || !Array.isArray(tbl.rows) || !tbl.rows.length) {
      children.push(new Paragraph({
        children:[new TextRun({text:`[Tabla ${tableIdx+1}]`, font:'Arial', size:20, color:'888780', italics:true})],
        alignment:AlignmentType.CENTER,
        spacing:{before:120, after:120}
      }));
      return;
    }
    // Calcular nº máximo de columnas
    const maxCols = tbl.rows.reduce((m, r) => Math.max(m, r.length), 0);

    // Construir filas, normalizando cada una al nº máximo de columnas
    const rows = tbl.rows.map((cells, ri) => {
      const isHeader = ri === 0;
      const norm = [];
      for (let i = 0; i < maxCols; i++) norm.push(cells[i] || '');
      return new TableRow({
        children: norm.map(text => new TableCell({
          width: { size: Math.floor(9000 / maxCols), type: WidthType.DXA },
          shading: isHeader ? { type: ShadingType.SOLID, color: CH2, fill: CH2 } : undefined,
          children:[new Paragraph({
            children:[new TextRun({
              text: ensurePeriod(String(text).trim()),
              font:'Arial', size:20,
              bold: isHeader,
              color: isHeader ? 'FFFFFF' : '1a1917'
            })],
            spacing:{before:60, after:60}
          })]
        }))
      });
    });

    // Pie / cabecera "Tabla N — comentada"
    children.push(new Paragraph({
      children:[new TextRun({text:`Tabla ${tableIdx+1}.`, font:'Arial', size:20, italics:true, bold:true, color:CH2})],
      spacing:{before:160, after:80},
      alignment:AlignmentType.CENTER
    }));
    children.push(new Table({
      width: { size: 9000, type: WidthType.DXA },
      rows
    }));
    // Recuadro de comentario
    const totalCells = tbl.rows.reduce((s,r)=>s+r.length,0);
    const summary = `Esta tabla recoge ${tbl.rows.length} fila${tbl.rows.length!==1?'s':''} y ${maxCols} columna${maxCols!==1?'s':''} con un total de ${totalCells} celdas con datos. Se incluye en este punto del documento por su valor descriptivo. Revisa el cuadro para una lectura detallada de cada fila.`;
    children.push(new Paragraph({
      children:[new TextRun({text: summary, font:'Arial', size:20, italics:true, color:'5c5a55'})],
      alignment:AlignmentType.JUSTIFIED,
      spacing:{before:120, after:200},
      border:{
        top: {style:BorderStyle.SINGLE, size:6, color:CL2, space:8},
        bottom: {style:BorderStyle.SINGLE, size:6, color:CL2, space:8},
        left: {style:BorderStyle.SINGLE, size:6, color:CL2, space:8},
        right: {style:BorderStyle.SINGLE, size:6, color:CL2, space:8}
      },
      indent:{left:200, right:200}
    }));
  }

  // Construir el cuerpo del documento a partir de los bloques
  // Soportar la inserción de preguntas inline mediante {t:'qmarker', i:n}
  for (const block of data.blocks||[]) {
    const {t, n, text, items, idx} = block;
    if (t === 'h1') {
      children.push(new Paragraph({
        heading:HeadingLevel.HEADING_1,
        children:[new TextRun({text:(n?n+' ':'')+ensurePeriod(text||''),font:'Arial',size:30,bold:true,color:CH1})],
        spacing:{before:440,after:180},
        border:{bottom:{style:BorderStyle.SINGLE,size:6,color:CL1}}
      }));
    } else if (t === 'h2') {
      children.push(new Paragraph({
        heading:HeadingLevel.HEADING_2,
        children:[new TextRun({text:(n?n+' ':'')+ensurePeriod(text||''),font:'Arial',size:26,bold:true,color:CH2})],
        spacing:{before:320,after:120},
        border:{bottom:{style:BorderStyle.SINGLE,size:4,color:CL2}}
      }));
    } else if (t === 'h3') {
      children.push(new Paragraph({
        heading:HeadingLevel.HEADING_3,
        children:[new TextRun({text:(n?n+' ':'')+ensurePeriod(text||''),font:'Arial',size:24,bold:true,color:CH3})],
        spacing:{before:260,after:100}
      }));
    } else if (t === 'p' && text) {
      children.push(new Paragraph({
        children:[new TextRun({text:ensurePeriod(text.trim()),font:'Arial',size:22, italics: !!block.auto})],
        spacing:{before:0,after:140},
        alignment:AlignmentType.JUSTIFIED
      }));
    } else if ((t === 'ul' || t === 'ol') && Array.isArray(items)) {
      // Cada `ol` usa su propia reference para que la numeración reinicie a 1.
      // El bloque ya viene anotado con `_numRef` desde el paso de pre-render.
      const reference = t === 'ul' ? 'bullets' : (block._numRef || 'numbers-0');
      for (const item of items) {
        const cleanText = stripListMarker(item).trim();
        if (!cleanText) continue;
        children.push(new Paragraph({
          numbering:{reference, level:0},
          children:[new TextRun({text:ensurePeriod(cleanText),font:'Arial',size:22})],
          spacing:{before:0,after:80}
        }));
      }
    } else if (t === 'img' && imageStore && typeof idx === 'number' && imageStore[idx]) {
      const img = imageStore[idx];
      const {width, height} = getImgDimensions(img.data, img.type);
      try {
        children.push(new Paragraph({
          alignment:AlignmentType.CENTER,
          children:[new ImageRun({data:img.data,transformation:{width,height},type:imgType(img.type)})],
          spacing:{before:200,after:80}
        }));
        children.push(new Paragraph({
          children:[new TextRun({text:`Figura ${idx+1}.`, font:'Arial', size:20, italics:true, color:'5c5a55'})],
          alignment:AlignmentType.CENTER,
          spacing:{before:0, after:200}
        }));
      } catch(_){
        children.push(new Paragraph({
          children:[new TextRun({text:`[Imagen ${idx+1}]`,font:'Arial',size:20,color:'888780'})],
          alignment:AlignmentType.CENTER,
          spacing:{before:120,after:120}
        }));
      }
    } else if (t === 'table' && typeof idx === 'number') {
      addTable(idx);
    } else if (t === 'qmarker' && quiz && Array.isArray(quiz.questions) && typeof block.i === 'number') {
      // Inserción inline de una pregunta
      addInlineQuiz(children, quiz, block.i, CH1, CH2, CL1);
    }
  }

  // ── Sección de autoevaluación al final (modo 'end') ────────────────────────
  if (quiz && Array.isArray(quiz.questions) && quiz.questions.length > 0 && (quiz.mode || 'end') === 'end') {
    appendFinalQuiz(children, quiz, CH1, CL1, CH2);
  }

  return makeDoc(children, data.title || 'Documento',
    null, // sin texto en el pie: solo número de página
    CBD, CBD,
    { h1Size:30, h1Color:CH1, h2Size:26, h2Color:CH2, h3Size:24, h3Color:CH3, headerColor:HDR,
      numberedListCount }
  );
}

// Inserta una pregunta concreta en línea, dentro del flujo del documento
function addInlineQuiz(children, quiz, qIdx, CH1, CH2, CL1) {
  const q = quiz.questions[qIdx];
  if (!q) return;
  const qLetters = ['A','B','C','D','E'];
  // Cabecera ligera de "Pregunta de control"
  children.push(new Paragraph({
    children:[new TextRun({text:`Pregunta de control ${qIdx+1}.`, font:'Arial', size:22, bold:true, color:CH2})],
    spacing:{before:240, after:80},
    border:{
      top:{style:BorderStyle.SINGLE, size:4, color:CL1, space:6},
      left:{style:BorderStyle.SINGLE, size:4, color:CL1, space:6}
    },
    indent:{left:120}
  }));
  children.push(new Paragraph({
    children:[new TextRun({text:q.q || '', font:'Arial', size:22})],
    spacing:{before:0, after:80},
    alignment:AlignmentType.JUSTIFIED,
    indent:{left:120}
  }));
  if (quiz.type === 'vf') {
    children.push(new Paragraph({
      children:[new TextRun({text:'☐ Verdadero            ☐ Falso', font:'Arial', size:22})],
      indent:{left:480}, spacing:{before:0, after:160}
    }));
  } else {
    const opts = q.options || [];
    opts.forEach((opt, j) => {
      children.push(new Paragraph({
        children:[
          new TextRun({text:`${qLetters[j]}.  `, font:'Arial', size:22, bold:true}),
          new TextRun({text:opt, font:'Arial', size:22})
        ],
        indent:{left:480}, spacing:{before:0, after: j===opts.length-1?160:60}
      }));
    });
  }
}

// Añade el bloque final de autoevaluación (modo 'end')
function appendFinalQuiz(children, quiz, CH1, CL1, CH2) {
  const qLetters = ['A','B','C','D','E'];
  children.push(new Paragraph({
    heading:HeadingLevel.HEADING_1,
    children:[new TextRun({text:'Autoevaluación.', font:'Arial', size:30, bold:true, color:CH1})],
    spacing:{before:600, after:200},
    border:{bottom:{style:BorderStyle.SINGLE, size:6, color:CL1}},
    pageBreakBefore:true
  }));
  const intro = quiz.type === 'vf'
    ? 'Indica si cada afirmación es Verdadera (V) o Falsa (F). Las soluciones se encuentran al final.'
    : `Selecciona la única respuesta correcta de cada pregunta. Las soluciones se encuentran al final.`;
  children.push(new Paragraph({
    children:[new TextRun({text:intro, font:'Arial', size:22, italics:true, color:'5c5a55'})],
    spacing:{before:0, after:240},
    alignment:AlignmentType.JUSTIFIED
  }));
  quiz.questions.forEach((q, i) => {
    children.push(new Paragraph({
      children:[
        new TextRun({text:`${i+1}. `, font:'Arial', size:22, bold:true}),
        new TextRun({text:q.q || '', font:'Arial', size:22})
      ],
      spacing:{before:200, after:100},
      alignment:AlignmentType.JUSTIFIED
    }));
    if (quiz.type === 'vf') {
      children.push(new Paragraph({
        children:[new TextRun({text:'☐ Verdadero            ☐ Falso', font:'Arial', size:22})],
        indent:{left:360},
        spacing:{before:0, after:80}
      }));
    } else {
      const opts = q.options || [];
      opts.forEach((opt, j) => {
        children.push(new Paragraph({
          children:[
            new TextRun({text:`${qLetters[j]}.  `, font:'Arial', size:22, bold:true}),
            new TextRun({text:opt, font:'Arial', size:22})
          ],
          indent:{left:360},
          spacing:{before:0, after:60}
        }));
      });
    }
  });
  // Soluciones
  children.push(new Paragraph({
    heading:HeadingLevel.HEADING_1,
    children:[new TextRun({text:'Soluciones.', font:'Arial', size:30, bold:true, color:CH1})],
    spacing:{before:600, after:200},
    border:{bottom:{style:BorderStyle.SINGLE, size:6, color:CL1}},
    pageBreakBefore:true
  }));
  quiz.questions.forEach((q, i) => {
    let ans = '';
    if (quiz.type === 'vf') {
      ans = q.correct ? 'Verdadero' : 'Falso';
    } else {
      ans = qLetters[q.correct] || '?';
    }
    const runs = [
      new TextRun({text:`${i+1}.  `, font:'Arial', size:22, bold:true}),
      new TextRun({text:`Respuesta correcta: ${ans}`, font:'Arial', size:22, bold:true, color:CH2})
    ];
    if (q.explanation) {
      runs.push(new TextRun({text:` — ${q.explanation}`, font:'Arial', size:21, color:'5c5a55'}));
    }
    children.push(new Paragraph({
      children:runs,
      spacing:{before:120, after:80},
      alignment:AlignmentType.JUSTIFIED
    }));
  });
}

// Distribuye preguntas inline en la lista de bloques (modo 'inline').
// Inserta {t:'qmarker', i:k} en posiciones repartidas, justo después de un párrafo.
function distributeInlineQuiz(blocks, totalQuestions) {
  if (!totalQuestions) return blocks;
  // Posiciones candidatas: tras un párrafo (no auto) o tras un cierre de lista.
  const candidates = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.t === 'p' && !b.auto) candidates.push(i);
    if (b.t === 'ul' || b.t === 'ol') candidates.push(i);
  }
  if (!candidates.length) return blocks;
  // Repartimos uniformemente
  const out = [];
  // Mapear de índice de bloque → preguntas a insertar después de ese bloque
  const insertAfter = new Map();
  for (let q = 0; q < totalQuestions; q++) {
    const pick = candidates[Math.floor((q + 0.5) * candidates.length / totalQuestions)];
    if (!insertAfter.has(pick)) insertAfter.set(pick, []);
    insertAfter.get(pick).push(q);
  }
  for (let i = 0; i < blocks.length; i++) {
    out.push(blocks[i]);
    if (insertAfter.has(i)) {
      for (const qi of insertAfter.get(i)) out.push({ t:'qmarker', i: qi });
    }
  }
  return out;
}

// ── Chunking de texto para maquetación de documentos largos ───────────────────
function splitIntoChunks(text, chunkSize = MAQ_CHUNK) {
  if (!text) return [];
  if (text.length <= chunkSize) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > chunkSize) {
    // Preferir cortar en doble salto de línea, luego en \n, luego por cabecera MAYÚSCULA, luego por caracter
    let cutPos = -1;
    const window = remaining.substring(0, chunkSize);
    // 1) Doble salto
    cutPos = window.lastIndexOf('\n\n');
    if (cutPos < chunkSize * 0.5) {
      // 2) Salto simple
      cutPos = window.lastIndexOf('\n');
      if (cutPos < chunkSize * 0.5) {
        // 3) Punto + espacio
        cutPos = window.lastIndexOf('. ');
        if (cutPos < chunkSize * 0.5) cutPos = chunkSize; // forzar
      }
    }
    chunks.push(remaining.substring(0, cutPos).trim());
    remaining = remaining.substring(cutPos).trim();
  }
  if (remaining.length) chunks.push(remaining.trim());
  return chunks.filter(c => c.length > 0);
}

// ── Prompts de maquetación ────────────────────────────────────────────────────
function buildMaquetaPrompt(options = {}) {
  const { hasImages = false, hasTables = false, chunkMode = false, chunkInfo = null } = options;
  const imgNote = hasImages
    ? `\nIMÁGENES: el texto contiene marcadores __IMG_N__. Inclúyelos en el flujo como {"t":"img","idx":N} en EXACTAMENTE la posición original. NO omitas ninguno.`
    : '';
  const tblNote = hasTables
    ? `\nTABLAS: el texto contiene marcadores __TABLE_N__. Inclúyelos como {"t":"table","idx":N} en su posición original. NO omitas ninguna tabla. NO las conviertas en texto, NI las resumas, NI las elimines: la tabla se renderizará automáticamente en el Word, tú solo la referencias por su índice.`
    : '';
  const chunkNote = chunkMode
    ? `\nESTA ES UNA SECCIÓN de un documento más extenso (${chunkInfo}). Estructura solo lo contenido en esta sección. Devuelve title vacío "" si es una sección intermedia. La numeración de los apartados será reasignada después por la aplicación, así que NO te preocupes por continuar la numeración del chunk anterior; numera desde 1 dentro de esta sección.`
    : '';

  return `Eres experto en maquetación académica SCORMXPRESS. Reestructura el contenido manteniendo TODO LITERAL.

═══ REGLA #1 — PRESERVACIÓN LITERAL DEL CONTENIDO (CRÍTICA, INNEGOCIABLE) ═══
- Debes incluir ABSOLUTAMENTE TODO el contenido proporcionado. NO resumir. NO omitir frases. NO acortar.
- Conserva la redacción original tal cual, incluyendo cifras, fechas, nombres propios, citas y referencias normativas.
- En textos jurídicos/normativos: preserva LITERALMENTE los términos: "Artículo", "Art.", "Título", "Capítulo", "Sección", "Subsección", "Apartado", "Disposición Adicional", "Disposición Transitoria", "Disposición Derogatoria", "Disposición Final", "Real Decreto", "Decreto", "Ley Orgánica", "Ley", "Orden", "Resolución", "Reglamento", "Anexo", numeración romana (I, II, III), letras de apartado a), b), c), etc.
- Si el texto fuente dice "Artículo 5.- Las personas..." debes mantener "Artículo 5.- Las personas..." literal en el bloque correspondiente.
- NO inventes contenido nuevo. NO añadas información que no esté en el original. La única excepción son los breves "puentes" entre títulos consecutivos (ver regla #6).
- Las imágenes y tablas marcadas con __IMG_N__ y __TABLE_N__ DEBEN aparecer todas, en su posición original.

═══ REGLA #2 — JERARQUÍA Y NUMERACIÓN ═══
1. Jerarquía máxima de 3 niveles: h1 (sección principal), h2 (subsección), h3 (detalle).
2. NUMERACIÓN: indica la numeración propuesta en el campo "n" ("1.", "1.1.", "1.1.1.", "2.", etc.). La aplicación reasignará la numeración global, pero respeta la JERARQUÍA: h1 lleva un nivel ("1."), h2 dos niveles ("1.1."), h3 tres niveles ("1.1.1.").
3. NO saltes niveles (no pongas h3 si el padre lógico no es h2).
4. No abras un h1 nuevo dentro de la misma sección temática; usa h2.

═══ REGLA #3 — PUNTO FINAL OBLIGATORIO ═══
- TODO bloque de texto (h1, h2, h3, p, items de listas) DEBE terminar con punto final ".".
- También los TÍTULOS y subtítulos llevan punto al final ("1. Introducción.", "1.1. Antecedentes históricos.").
- Esto es crítico porque el texto se locutará con IA y sin punto la lectura no pausa correctamente.

═══ REGLA #4 — DISTINCIÓN PÁRRAFO vs TÍTULO ═══
- Un h1/h2/h3 debe ir SIEMPRE seguido de contenido sustancial (al menos un párrafo de varias frases o varios elementos de lista).
- ELEMENTOS DE LISTA: viñetas, ítems numerados (a), b), c) — 1º, 2º, 3º — i, ii, iii — •, –, *) NUNCA se marcan como h1/h2/h3. Van como items dentro de "ul" u "ol".
- EPÍGRAFES CORTOS / ETIQUETAS DE CAMPO ("OBJETIVO:", "REQUISITOS:", "DEFINICIÓN:", "PLAZO:", "ART. 5:") cuando van seguidos del valor en la misma frase NO son títulos: inclúyelos dentro del párrafo.
- ARTÍCULOS dentro de un texto normativo: "Artículo 5.-", "Apartado a)", "Disposición Adicional Primera" — si son cabecera de un articulado completo con varios párrafos debajo, sí son h2/h3; si son sólo numeración de un punto dentro de una enumeración, van como item.
- PIES DE IMAGEN, citas, notas al pie: van como párrafo, NUNCA como título.
- En caso de duda entre marcar un texto como título o como párrafo: elige PÁRRAFO.

═══ REGLA #5 — LISTAS ═══
- Listas con viñetas (ul) para enumeraciones no ordenadas y listas numeradas (ol) para pasos o secuencias.
- Cada item termina en punto.
- NUNCA incluyas el marcador de lista DENTRO del texto del item: si lo marcas como "ul", NO escribas "a) Texto" ni "• Texto" — escribe sólo "Texto". El renderizador añade el marcador. Lo contrario produce doble viñeta ("• a) Texto").
- Ejemplo CORRECTO  : {"t":"ul","items":["Ubicación territorial.","Titularidad."]}
- Ejemplo INCORRECTO: {"t":"ul","items":["a) Ubicación territorial.","b) Titularidad."]}
- Cada bloque "ol" arranca con numeración 1, 2, 3… INDEPENDIENTE de listas anteriores. NO continúes la numeración entre listas: si dos artículos del temario tienen cada uno su propia enumeración, son DOS bloques "ol" distintos, no uno solo.

═══ REGLA #6 — TRANSICIONES ENTRE TÍTULOS CONSECUTIVOS ═══
- Si tras un h1, h2 o h3 NO hay contenido sustancial original antes del siguiente h2/h3 (es decir, dos títulos consecutivos sin texto entre ellos), añade un BREVE párrafo introductorio (1-3 frases) de cosecha propia que presente brevemente el contenido del subapartado siguiente y enlace con la sección anterior. Marca este párrafo con "auto":true para identificarlo.
- Ejemplo: si hay h1 "5. Procedimiento administrativo." inmediatamente seguido de h2 "5.1. Iniciación.", inserta entre ellos un párrafo tipo: {"t":"p","auto":true,"text":"El procedimiento administrativo se desarrolla a través de varias fases. A continuación se examinan en detalle, comenzando por la fase de iniciación."}.
- Estos párrafos auto SOLO se generan cuando faltan; NO sustituyen ni resumen el contenido original.${imgNote}${tblNote}${chunkNote}

═══ FORMATO DE SALIDA ═══
Devuelve ÚNICAMENTE JSON válido (sin texto antes ni después, sin \`\`\`json) con esta estructura:
{
  "title": "Título del documento (vacío si es sección intermedia)",
  "blocks": [
    {"t":"h1","n":"1.","text":"Título de sección."},
    {"t":"p","auto":true,"text":"Breve párrafo puente generado automáticamente."},
    {"t":"h2","n":"1.1.","text":"Subtítulo."},
    {"t":"p","text":"Párrafo completo terminado en punto."},
    {"t":"ul","items":["Primer punto terminado en punto.","Segundo punto terminado en punto."]},
    {"t":"ol","items":["Primer paso.","Segundo paso."]},
    {"t":"img","idx":0},
    {"t":"table","idx":0}
  ]
}

═══ REGLAS DE JSON VÁLIDO (CRÍTICAS) ═══
- Si el texto original contiene COMILLAS DOBLES (p.ej. una cita: el autor afirma "X"), debes
  ESCAPARLAS como \\" dentro del campo "text". Ejemplo correcto:
    {"t":"p","text":"El autor afirma \\"la gestión pública\\" como pilar."}
  NUNCA dejes una " sin escapar dentro de un string — el JSON quedará inválido y el documento
  no podrá maquetarse.
- Alternativa más segura: SUSTITUYE las comillas dobles del texto original por COMILLAS
  TIPOGRÁFICAS «» o "" (U+00AB/U+00BB o U+201C/U+201D). Estas no rompen el JSON.
- Los saltos de línea dentro de un "text" deben escaparse como \\n. Lo más limpio: no metas
  saltos de línea; usa puntos y separa en párrafos distintos ({"t":"p",...} consecutivos).
- Los retrocesos (\\) en el texto original deben escaparse como \\\\.`;
}

// Intenta recuperar JSON parcial cuando llega truncado por max_tokens.
// Recorre los bloques abiertos en "blocks":[ y cierra en el último completo.
function tryRecoverJson(s) {
  const blocksIdx = s.indexOf('"blocks"');
  if (blocksIdx < 0) return null;
  const arrStart = s.indexOf('[', blocksIdx);
  if (arrStart < 0) return null;
  let depth = 0, inStr = false, esc = false, lastBlockEnd = -1;
  for (let i = arrStart + 1; i < s.length; i++) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) lastBlockEnd = i;
    } else if (c === ']' && depth === 0) break;
  }
  if (lastBlockEnd < 0) return null;
  return s.substring(0, lastBlockEnd + 1) + ']}';
}

// jsonrepair: librería estándar para reparar JSON con errores comunes
// (comillas no escapadas, comas finales, truncamientos, valores sin comillas…).
// Es lo que arregla el caso típico de Claude metiendo `"` dentro de un string
// de texto literal sin escaparlas → `Expected ',' or '}' after property value`.
const { jsonrepair } = require('jsonrepair');

function parseMaqJson(raw) {
  let s = raw.replace(/```json|```/g,'').trim();
  const si = s.indexOf('{'), ei = s.lastIndexOf('}') + 1;
  if (si >= 0 && ei > si) s = s.substring(si, ei);
  let data;
  let repaired = false;
  try {
    data = JSON.parse(s);
  } catch (e) {
    // 1) Intentar con jsonrepair (comillas mal escapadas, comas sobrantes, etc.).
    try {
      const fixed = jsonrepair(s);
      data = JSON.parse(fixed);
      repaired = true;
    } catch (_) {
      // 2) Si jsonrepair no puede, intentar recuperar truncado al final.
      const recovered = tryRecoverJson(s);
      if (recovered) {
        try {
          data = JSON.parse(recovered);
          data._truncated = true;
        } catch (_) {
          // 3) Último intento: jsonrepair sobre el recovered.
          try {
            data = JSON.parse(jsonrepair(recovered));
            data._truncated = true;
            repaired = true;
          } catch (_) {
            throw new Error('JSON inválido y no recuperable: ' + e.message);
          }
        }
      } else {
        throw new Error('JSON inválido: ' + e.message);
      }
    }
  }
  if (!data.blocks || !Array.isArray(data.blocks)) throw new Error('JSON inválido: falta blocks[]');
  if (repaired) data._repaired = true;
  return data;
}

// ── Post-procesado: renumeración global, puntos finales, transiciones automáticas
// Toma los bloques y devuelve los bloques limpios + estadísticas.
function normalizeMaquetaData(data, opts = {}) {
  const blocks = Array.isArray(data.blocks) ? data.blocks.slice() : [];

  // 0) Eliminar duplicados consecutivos exactos de imágenes/tablas
  const dedup = [];
  let lastImgIdx = -1, lastTblIdx = -1;
  for (const b of blocks) {
    if (b.t === 'img' && typeof b.idx === 'number') {
      if (b.idx === lastImgIdx) continue;
      lastImgIdx = b.idx;
    } else if (b.t === 'table' && typeof b.idx === 'number') {
      if (b.idx === lastTblIdx) continue;
      lastTblIdx = b.idx;
    } else {
      lastImgIdx = -1; lastTblIdx = -1;
    }
    dedup.push(b);
  }

  // 1) Insertar transiciones automáticas entre títulos consecutivos (sin texto entre ellos).
  //    Solo se inserta cuando el modelo no haya generado ya un párrafo "auto":true.
  const isHeading = b => b && (b.t === 'h1' || b.t === 'h2' || b.t === 'h3');
  const isContent = b => b && ['p','ul','ol','img','table'].includes(b.t);
  const withBridges = [];
  for (let i = 0; i < dedup.length; i++) {
    withBridges.push(dedup[i]);
    if (isHeading(dedup[i])) {
      const next = dedup[i + 1];
      if (next && isHeading(next)) {
        // Necesita puente — texto introductorio breve genérico
        const heading = String(dedup[i].text || '').replace(/\.$/, '').trim();
        const subheading = String(next.text || '').replace(/\.$/, '').trim();
        const intro = `En este apartado se desarrolla "${heading}". A continuación se examina ${subheading.toLowerCase() ? `"${subheading}"` : 'el siguiente subapartado'}, abordando los aspectos fundamentales de este bloque temático.`;
        withBridges.push({ t:'p', auto:true, text: intro });
      }
    }
  }

  // 2) Renumeración global y jerárquica (siempre limpia y secuencial)
  let counters = [0, 0, 0]; // h1, h2, h3
  for (const b of withBridges) {
    if (b.t === 'h1') {
      counters[0] += 1; counters[1] = 0; counters[2] = 0;
      b.n = `${counters[0]}.`;
    } else if (b.t === 'h2') {
      // Si aparece h2 sin h1, asumimos h1 implícito (counters[0] >= 1)
      if (counters[0] === 0) counters[0] = 1;
      counters[1] += 1; counters[2] = 0;
      b.n = `${counters[0]}.${counters[1]}.`;
    } else if (b.t === 'h3') {
      if (counters[0] === 0) counters[0] = 1;
      if (counters[1] === 0) counters[1] = 1;
      counters[2] += 1;
      b.n = `${counters[0]}.${counters[1]}.${counters[2]}.`;
    }
  }

  // 3) Forzar punto final en TODO texto (h1/h2/h3/p e items de listas)
  for (const b of withBridges) {
    if (['h1','h2','h3','p'].includes(b.t) && b.text) {
      b.text = ensurePeriod(String(b.text).trim());
    }
    if ((b.t === 'ul' || b.t === 'ol') && Array.isArray(b.items)) {
      b.items = b.items.map(it => ensurePeriod(String(it || '').trim())).filter(Boolean);
    }
  }

  // 4) Validar índices de imágenes/tablas; conservarlos solo si están en el rango disponible
  const imgCount = opts.imgCount || 0;
  const tblCount = opts.tblCount || 0;
  const finalBlocks = withBridges.filter(b => {
    if (b.t === 'img') {
      if (typeof b.idx !== 'number' || b.idx < 0 || b.idx >= imgCount) return false;
    }
    if (b.t === 'table') {
      if (typeof b.idx !== 'number' || b.idx < 0 || b.idx >= tblCount) return false;
    }
    return true;
  });

  // 5) Si el modelo se ha "saltado" alguna imagen o tabla, las añadimos al final como respaldo
  //    para asegurar que TODAS aparezcan en el documento (regla del usuario).
  const usedImg = new Set(finalBlocks.filter(b=>b.t==='img').map(b=>b.idx));
  const usedTbl = new Set(finalBlocks.filter(b=>b.t==='table').map(b=>b.idx));
  const missingImg = [];
  const missingTbl = [];
  for (let i = 0; i < imgCount; i++) if (!usedImg.has(i)) missingImg.push(i);
  for (let i = 0; i < tblCount; i++) if (!usedTbl.has(i)) missingTbl.push(i);
  if (missingImg.length || missingTbl.length) {
    finalBlocks.push({ t:'h2', n:'', text:'Material gráfico complementario.', _appendix:true });
    for (const idx of missingImg) finalBlocks.push({ t:'img', idx });
    for (const idx of missingTbl) finalBlocks.push({ t:'table', idx });
    // re-numerar para incluir esta cabecera apéndice
    counters = [0,0,0];
    for (const b of finalBlocks) {
      if (b.t === 'h1') { counters[0]+=1; counters[1]=0; counters[2]=0; b.n=`${counters[0]}.`; }
      else if (b.t === 'h2') { if(counters[0]===0)counters[0]=1; counters[1]+=1; counters[2]=0; b.n=`${counters[0]}.${counters[1]}.`; }
      else if (b.t === 'h3') { if(counters[0]===0)counters[0]=1; if(counters[1]===0)counters[1]=1; counters[2]+=1; b.n=`${counters[0]}.${counters[1]}.${counters[2]}.`; }
    }
  }

  return {
    title: data.title || '',
    blocks: finalBlocks
  };
}

// ── Prompts de preguntas test (anti-meta + polaridad + anti-repetición) ──────
function buildQuestionsPrompt(topic, nQ, type, diff, minW, maxW, numOpts, polarity, extra, previousStems = []) {
  const letters = LETTERS.slice(0, numOpts);
  const dM = {
    bajo:  `BAJA — preguntas sobre definiciones directas, datos concretos y conceptos básicos. Las opciones distractoras pueden ser claramente diferenciables. La respuesta correcta debe ser localizable de forma literal en el contenido.`,
    medio: `MEDIA — preguntas que exigen comprensión y aplicación. Combinan dos o más conceptos, requieren identificar relaciones, comparar definiciones cercanas o aplicar una regla a un caso simple. Las distractoras deben ser plausibles para quien sólo conozca el tema superficialmente.`,
    alto:  `ALTA — preguntas de análisis y síntesis. Exigen distinguir entre conceptos próximos, identificar excepciones, matices, plazos exactos, requisitos acumulativos, jurisprudencia o aplicación a casos complejos. TODAS las opciones deben ser plausibles para alguien que domine el tema; sólo el dominio profundo permite acertar.`
  };
  const tM = {
    teorico:  'TEÓRICAS: sobre conceptos, principios, definiciones y marco normativo.',
    practico: 'SUPUESTOS PRÁCTICOS: incluye un escenario de 2-5 frases contextualizando un caso. El enunciado y las opciones deben evaluar la aplicación del conocimiento al caso.'
  };
  // Polaridad
  let polarityInstr = '';
  if (polarity === 'positive') {
    polarityInstr = 'FORMULACIÓN: TODAS en POSITIVO (se pregunta cuál es verdadero, correcto, se aplica, etc.). PROHIBIDO formular en negativo ("NO es", "excepto", "no se aplica", "señala la falsa").';
  } else if (polarity === 'negative') {
    polarityInstr = 'FORMULACIÓN: TODAS en NEGATIVO (se pregunta cuál es falso, incorrecto, no se aplica, o qué opción es la excepción). Incluye expresiones tipo "NO es", "señala la incorrecta", "todas excepto", "cuál es falsa". La respuesta marcada como correcta es la opción que responde a la formulación negativa.';
  } else if (polarity === 'mix') {
    polarityInstr = 'FORMULACIÓN MIXTA: combina preguntas en positivo y preguntas en negativo según las proporciones indicadas por el usuario. En las negativas usa formulaciones tipo "NO es", "señala la incorrecta", "todas excepto", "cuál es falsa".';
  }

  // Anti-repetición: lista de enunciados ya generados en este tema
  let antiRep = '';
  if (previousStems && previousStems.length) {
    const sample = previousStems.slice(-40); // últimos 40 enunciados
    antiRep = `\nPREGUNTAS YA GENERADAS EN ESTE TEMA (PROHIBIDO REPETIR ni reformular con misma estructura/concepto):\n${sample.map((s,i)=>`${i+1}. ${s.substring(0,140)}`).join('\n')}\nDebes proponer enunciados sobre conceptos, datos o aspectos DISTINTOS a los anteriores y con una formulación gramatical claramente DIFERENTE.\n`;
  }

  return `Genera EXACTAMENTE ${nQ} preguntas tipo test en ESPAÑOL en formato Aiken para Moodle, con CALIDAD DE EXAMEN OFICIAL DE OPOSICIÓN.

NIVEL DE DIFICULTAD OBLIGATORIO PARA TODAS LAS PREGUNTAS DE ESTE LOTE: ${dM[diff]}
NO mezcles dificultades. TODAS las ${nQ} preguntas deben ajustarse al mismo nivel descrito arriba.

OPCIONES: ${numOpts} (${letters.join(', ')}) · TIPO: ${tM[type]}
EXTENSIÓN del enunciado: ${minW}-${maxW} palabras · FUENTE: EXCLUSIVAMENTE el contenido proporcionado.
${polarityInstr}

REGLAS DE UNICIDAD Y VARIEDAD ESTRUCTURAL (CRÍTICAS):
1. UNICIDAD: cada pregunta debe ser ÚNICA en concepto, enfoque y formulación. PROHIBIDO repetir el mismo asunto desde otro ángulo.
2. ESTRUCTURA VARIADA: NO puedes usar el mismo molde de enunciado más de UNA vez en el lote. Alterna estos formatos:
   • Pregunta directa abierta: "¿Qué órgano es competente para…?"
   • Definición inversa: "Se denomina X a aquella actuación que…"
   • Atribución funcional: "Corresponde a…"
   • Plazo / requisito: "El plazo para… es de…"
   • Completar una afirmación: "La normativa establece que…"
   • Identificar la excepción (si polaridad lo permite): "Es correcto SALVO…"
   • Caso/supuesto cuando proceda
   • Requisitos acumulativos / clasificación
   PROHIBIDO repetir cualquier patrón tipo "¿Cuál es el objetivo de…?", "¿Qué establece el artículo…?", "¿Qué es la…?" más de una vez.
3. RESPUESTA CORRECTA DISTRIBUIDA: la letra correcta debe variar entre ${letters.join(', ')} a lo largo del lote (no concentres respuestas en una sola letra).
4. OPCIONES INTELIGENTES: las ${numOpts} opciones deben tener longitud similar, ser todas plausibles, sin pistas léxicas y sin "todas las anteriores" / "ninguna de las anteriores".
5. NO REPETIR OPCIONES: dentro de una misma pregunta, las opciones deben ser claramente diferenciables. A lo largo del lote, no copies exactamente la misma opción/respuesta correcta de una pregunta a otra.

REGLAS ESTRICTAS DE REDACCIÓN (OBLIGATORIAS):
- PROHIBIDO usar expresiones metareferentes a la fuente. No escribas NUNCA frases como: "según lo estudiado", "según el texto", "según el documento", "de acuerdo con lo leído", "como se indica en el texto", "según se ha visto", "el autor afirma", "en el temario", "conforme al material", "de lo expuesto", "como se menciona", "en la lectura", "según lo anterior".
- Las preguntas deben formularse como conocimiento objetivo de la materia, sin referencia alguna a que existe un documento fuente.
- No uses "¿Qué dice el texto sobre...?" ni similares. Pregunta directamente: "¿Qué es X?", "¿Cuál es la función de Y?", "¿Cuántos Z hay en W?".
- Cada opción incorrecta debe ser plausible pero objetivamente falsa según el contenido proporcionado.
- No numeres las preguntas (ni "1.", ni "Pregunta 1:").
- No incluyas explicación, comentario o rationale. Solo enunciado, opciones y ANSWER.
${extra ? 'INSTRUCCIONES ADICIONALES: ' + extra : ''}
${antiRep}
FORMATO AIKEN ESTRICTO (respeta saltos de línea exactos):
Enunciado de la pregunta terminado en interrogación o afirmación clara
${letters.map((l,i)=>`${l}. Opción ${i+1}`).join('\n')}
ANSWER: ${letters[0]}

Separa cada pregunta del siguiente bloque con una línea en blanco.
GENERA LAS ${nQ} PREGUNTAS:`;
}

// Extrae los enunciados (parte previa a las opciones A/B/C/D/E y a ANSWER) de un texto Aiken
function extractAikenStems(aikenText) {
  if (!aikenText) return [];
  const blocks = aikenText.split(/\n\s*\n+/);
  const stems = [];
  for (const block of blocks) {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    const qLines = [];
    for (const line of lines) {
      if (/^[A-E]\.\s/.test(line) || /^ANSWER\s*:/.test(line)) break;
      qLines.push(line);
    }
    const stem = qLines.join(' ').trim();
    if (stem.length > 8) stems.push(stem);
  }
  return stems;
}

// ── POST /api/upload ──────────────────────────────────────────────────────────
app.post('/api/upload', aiLimiter, upload.array('files', MAX_TOPICS), async (req, res) => {
  if (!req.files?.length) return res.status(400).json({ error:'No se recibieron archivos.' });
  try {
    const topics = await Promise.all(req.files.map(async file => {
      const id = uuidv4();
      // Corregir mojibake del filename si llegó UTF-8 leído como Latin-1
      file.originalname = fixMojibake(file.originalname);
      const isPdfExt = /\.pdf$/i.test(file.originalname);
      const signature = detectFileSignature(file.buffer);

      // Bloqueo 1: la firma debe coincidir con la extensión declarada
      if (isPdfExt && signature !== 'pdf') {
        throw new Error(`"${file.originalname}" no es un PDF válido (firma incorrecta).`);
      }
      if (!isPdfExt && signature !== 'zip' && signature !== 'cfb') {
        throw new Error(`"${file.originalname}" no es un documento Word válido (firma incorrecta).`);
      }

      let topic;
      if (isPdfExt) {
        // PDF: el parsing se hace en un worker aislado (memoria + timeout)
        const base64 = file.buffer.toString('base64');
        let text = '', pages = 0;
        try {
          const parsed = await parseInWorker('pdf', file.buffer);
          text = (parsed.text || '').trim();
          pages = parsed.numpages || 0;
        } catch(e) {
          console.warn('[upload] worker pdf error:', e.message);
        }
        const words = text ? text.split(/\s+/).filter(Boolean).length : 0;
        topic = {
          id, name:file.originalname, type:'pdf',
          base64, text, words, pages,
          sizeKB: Math.round(file.size/1024),
          images: []
        };
      } else {
        // DOCX: convertToHtml (con imágenes) en worker; si falla, fallback a texto plano en worker.
        const tables = [];
        let textWithMarkers = '';
        let images = [];
        try {
          const r = await parseInWorker('docx-html', file.buffer);
          // r.images viene como Array<{data:Uint8Array,type}>; convertimos a Buffer para uso interno
          images = (r.images || []).map(im => ({ data: Buffer.from(im.data), type: im.type }));
          textWithMarkers = htmlToText(r.html, tables);
        } catch(e) {
          console.warn('[upload] worker docx-html error, fallback a texto:', e.message);
          const r = await parseInWorker('docx-text', file.buffer);
          textWithMarkers = r.text || '';
        }
        const words = textWithMarkers.replace(/__IMG_\d+__/g,'').replace(/__TABLE_\d+__/g,'').split(/\s+/).filter(Boolean).length;
        if (words < 10) throw new Error(`"${file.originalname}" tiene muy poco texto.`);
        topic = { id, name:file.originalname, type:'docx', text:textWithMarkers, images, tables, words };
      }
      addToTopicCache(req.user.id, id, topic);
      return {
        id, name:topic.name, type:topic.type,
        words: topic.words || null,
        sizeKB: topic.sizeKB || null,
        imageCount: topic.images?.length || 0,
        tableCount: topic.tables?.length || 0,
        pages: topic.pages || null,
        largeDoc: (topic.text?.length || 0) > MAQ_SINGLE
      };
    }));
    res.json({ success:true, topics });
  } catch(err) {
    console.error('[upload] error:', err.message);
    res.status(500).json({ error:'Error procesando el documento.' });
  }
});

// ── POST /api/generate (SSE) — banco de preguntas ─────────────────────────────
app.post('/api/generate', aiLimiter, async (req, res) => {
  res.setHeader('Content-Type','text/event-stream');
  res.setHeader('Cache-Control','no-cache');
  res.setHeader('Connection','keep-alive');
  res.setHeader('X-Accel-Buffering','no');
  res.flushHeaders();

  let clientAborted = false;
  req.on('close', () => { clientAborted = true; });

  const send = d => {
    if (clientAborted) return;
    try { res.write(`data: ${JSON.stringify(d)}\n\n`); } catch(_){}
  };
  const { topicIds, config } = req.body || {};
  if (!Array.isArray(topicIds) || !topicIds.length || !config || typeof config !== 'object') {
    send({type:'error',message:'Parámetros inválidos.'}); return res.end();
  }
  if (topicIds.length > MAX_TOPICS) { send({type:'error',message:'Demasiados temas.'}); return res.end(); }
  const topics = topicIds.filter(id => typeof id === "string").map(id => getOwnedTopic(req, id)).filter(Boolean);
  if (!topics.length) { send({type:'error',message:'Temas no encontrados.'}); return res.end(); }

  const perTopic = config.generationMode === 'pertopic';
  const nT = topics.length;

  function getQ(i) {
    if (perTopic) return config.numQ;
    return i === nT - 1
      ? config.numQ - Math.floor(config.numQ / nT) * (nT - 1)
      : Math.floor(config.numQ / nT);
  }
  function getDiffs(total) {
    if (config.diffMode === 'single') return [{ d: config.diffSingle, q: total }];
    const b = +config.diffBajo || 0, m = +config.diffMedio || 0, a = +config.diffAlto || 0;
    const t = b + m + a || 100;
    // Distribución proporcional con la última activa absorbiendo cualquier remanente
    // de redondeo, garantizando que la suma sea EXACTAMENTE total.
    const allocs = [
      { d:'bajo',  pct:b },
      { d:'medio', pct:m },
      { d:'alto',  pct:a }
    ].filter(x => x.pct > 0);
    if (!allocs.length) return [{ d: 'medio', q: total }];
    const out = [];
    let rem = total;
    for (let i = 0; i < allocs.length; i++) {
      const isLast = i === allocs.length - 1;
      let q = isLast ? rem : Math.min(rem, Math.round(total * allocs[i].pct / t));
      if (q < 0) q = 0;
      if (q > 0) out.push({ d: allocs[i].d, q });
      rem -= q;
    }
    return out.filter(x => x.q > 0);
  }
  function getTypes(total) {
    if (config.typeMode !== 'mix') return [{ t: config.typeMode, n: total }];
    const np = Math.round(total * (+config.typeMixPct || 50) / 100);
    const nt = total - np;
    const r = [];
    if (nt > 0) r.push({ t:'teorico', n:nt });
    if (np > 0) r.push({ t:'practico', n:np });
    return r;
  }
  function getPolarities(total) {
    const mode = config.polarityMode || 'positive';
    if (mode === 'positive') return [{ p:'positive', n:total }];
    if (mode === 'negative') return [{ p:'negative', n:total }];
    // mix
    const pos = Math.round(total * (+config.polarityPositivePct || 80) / 100);
    const neg = total - pos;
    const r = [];
    if (pos > 0) r.push({ p:'positive', n:pos });
    if (neg > 0) r.push({ p:'negative', n:neg });
    return r;
  }

  // Calcular total de lotes
  let totalBatches = 0;
  for (let i = 0; i < nT; i++) {
    const topicQ = getQ(i);
    for (const {n:typeN} of getTypes(topicQ)) {
      for (const {q:diffQ} of getDiffs(typeN)) {
        for (const {n:polN} of getPolarities(diffQ)) {
          totalBatches += Math.ceil(polN / BATCH_SIZE);
        }
      }
    }
  }

  let done = 0;
  send({ type:'start', totalTopics:nT, totalBatches });

  try {
    for (let ti = 0; ti < nT; ti++) {
      const topic = topics[ti];
      const topicQ = getQ(ti);
      send({ type:'topic_start', ti, name:topic.name, questions:topicQ });
      const parts = [];
      const previousStems = []; // Anti-repetición: enunciados ya generados para este tema

      for (const {t, n:typeN} of getTypes(topicQ)) {
        for (const {d, q:diffQ} of getDiffs(typeN)) {
          for (const {p, n:polN} of getPolarities(diffQ)) {
            let emitted = 0;
            while (emitted < polN) {
              if (clientAborted) return;
              const bQ = Math.min(BATCH_SIZE, polN - emitted);
              done++;
              send({
                type:'batch', ti, batchDone:done, totalBatches,
                pct: Math.round(done/totalBatches*100),
                label: `Tema ${ti+1}/${nT} · "${topic.name.replace(/\.[^.]+$/,'')}" · ${t==='teorico'?'Teórica':'Práctica'} · Dif. ${d} · ${p==='positive'?'positivas':'negativas'} · lote ${Math.ceil((emitted+1)/BATCH_SIZE)}/${Math.ceil(polN/BATCH_SIZE)}`
              });
              const text = await callClaude(
                makeMessages(
                  buildQuestionsPrompt(topic, bQ, t, d, config.minW, config.maxW, config.numOpts, p, config.extraCtx || '', previousStems),
                  topic
                )
              );
              parts.push(text);
              // Acumula los enunciados del lote para evitar repeticiones en lotes siguientes
              const newStems = extractAikenStems(text);
              if (newStems.length) previousStems.push(...newStems);
              emitted += bQ;
            }
          }
        }
      }
      const topicText = parts.join('\n\n');
      send({
        type:'topic_result', ti, name:topic.name,
        text: topicText,
        count: (topicText.match(/^ANSWER:/gm) || []).length
      });
    }
    send({ type:'complete' });
  } catch(err) {
    send({ type:'error', message: err.message });
  } finally {
    res.end();
  }
});

// ── POST /api/summarize (SSE) ─────────────────────────────────────────────────
app.post('/api/summarize', aiLimiter, async (req, res) => {
  res.setHeader('Content-Type','text/event-stream');
  res.setHeader('Cache-Control','no-cache');
  res.setHeader('Connection','keep-alive');
  res.setHeader('X-Accel-Buffering','no');
  res.flushHeaders();

  let clientAborted = false;
  req.on('close', () => { clientAborted = true; });

  const send = d => {
    if (clientAborted) return;
    try { res.write(`data: ${JSON.stringify(d)}\n\n`); } catch(_){}
  };
  const { topicIds, pages } = req.body || {};
  if (!Array.isArray(topicIds) || !topicIds.length) { send({type:'error',message:'Temas no recibidos.'}); return res.end(); }
  if (topicIds.length > MAX_TOPICS) { send({type:'error',message:'Demasiados temas.'}); return res.end(); }
  const pagesNum = Math.max(1, Math.min(50, parseInt(pages) || 1));
  const topics = topicIds.filter(id => typeof id === "string").map(id => getOwnedTopic(req, id)).filter(Boolean);
  if (!topics.length) { send({type:'error',message:'Temas no encontrados.'}); return res.end(); }
  const tw = pagesNum * 480;
  send({ type:'start', total:topics.length });

  try {
    for (let i = 0; i < topics.length; i++) {
      if (clientAborted) return;
      const topic = topics[i];
      send({ type:'progress', current:i+1, total:topics.length, name:topic.name });
      const prompt = `Genera un resumen académico exhaustivo con aproximadamente ${tw} palabras (${pagesNum} páginas Word). Organízalo con SUBTÍTULOS EN MAYÚSCULAS para cada bloque temático. Cubre TODOS los conceptos. Español académico correcto. Todos los párrafos deben terminar con punto. Alcanza los ${tw} palabras.`;
      const text = await callClaude(
        makeMessages(prompt, topic),
        Math.min(16000, Math.max(4000, tw*2))
      );
      send({ type:'result', name:topic.name, text, wordCount: text.split(/\s+/).filter(Boolean).length });
    }
    send({ type:'complete' });
  } catch(err) {
    console.error('[summarize] error:', err.message);
    send({ type:'error', message: 'Error generando el resumen.' });
  } finally {
    res.end();
  }
});

app.post('/api/summary-docx', async (req,res) => {
  const { name, text } = req.body || {};
  if (typeof text !== 'string' || !text) return res.status(400).json({ error:'Sin contenido.' });
  if (text.length > 200000) return res.status(413).json({ error:'Texto demasiado largo.' });
  try {
    const buf = await Packer.toBuffer(buildSummaryDoc(name || 'Resumen', text));
    const safe = (name || 'resumen')
      .replace(/\.[^.]+$/, '')
      .replace(/[^\w\-áéíóúüñÁÉÍÓÚÜÑ ]/g, '_')
      .substring(0, 60);
    res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition',`attachment; filename="resumen_${safe}.docx"`);
    res.send(buf);
  } catch(err) {
    console.error('[summary-docx] error:', err.message);
    res.status(500).json({ error:'Error generando el documento.' });
  }
});

// ── POST /api/map — mapa conceptual (radial + Novak) ──────────────────────────
app.post('/api/map', aiLimiter, async (req, res) => {
  const { topicId, depth, style } = req.body || {};
  const topic = getOwnedTopic(req, topicId);
  if (!topic) return res.status(404).json({ error:'Tema no encontrado.' });
  const mapStyle = style === 'novak' ? 'novak' : 'radial';

  // ── Estilo radial (centro → ramas → subnodos) ────────────────────────────
  if (mapStyle === 'radial') {
    const dm = {
      simple:    '4-5 ramas · 2-3 subnodos',
      completo:  '6-7 ramas · 3-4 subnodos',
      detallado: '7-8 ramas · 4-5 subnodos'
    };
    const prompt = `Analiza el documento y genera un mapa conceptual radial. Devuelve ÚNICAMENTE JSON válido:
{"title":"Título (máx 4 palabras)","branches":[{"label":"Concepto (2-4 palabras)","nodes":["Subconcepto"]}]}
Estructura: ${dm[depth] || dm.completo}`;
    try {
      let raw = await callClaude(makeMessages(prompt, topic), 4000);
      raw = raw.replace(/```json|```/g,'').trim();
      const s = raw.indexOf('{'), e = raw.lastIndexOf('}') + 1;
      if (s >= 0) raw = raw.substring(s, e);
      const data = JSON.parse(raw);
      if (!data.title || !data.branches?.length) throw new Error('JSON inválido');
      return res.json({ success:true, style:'radial', data });
    } catch(err) {
      console.error('[map radial] error:', err.message);
      return res.status(500).json({ error:'No se pudo generar el mapa.' });
    }
  }

  // ── Estilo Novak (conceptos + frases de enlace + cross-links) ────────────
  const dm = {
    simple:    '2 macroconceptos en nivel 0 · 1 nivel de subconceptos · ~8-10 conceptos en total · ~7-9 proposiciones',
    completo:  '3-4 macroconceptos en nivel 0 · 2 niveles de subconceptos · ~14-18 conceptos en total · ~16-22 proposiciones · 1-2 cross-links entre ramas distintas',
    detallado: '4-5 macroconceptos en nivel 0 · 2-3 niveles de subconceptos · ~22-28 conceptos en total · ~26-32 proposiciones · 3-4 cross-links entre ramas distintas'
  };
  const prompt = `Analiza el documento y genera un MAPA CONCEPTUAL DE NOVAK (NO un mapa radial ni una lista jerárquica). Devuelve ÚNICAMENTE JSON válido con esta estructura exacta:
{
  "title": "Título general del mapa (máx 5 palabras)",
  "concepts": [
    {"id":"c1","text":"NOMBRE DEL MACROCONCEPTO","level":0},
    {"id":"c2","text":"Subconcepto","level":1},
    {"id":"c3","text":"Subnodo específico","level":2}
  ],
  "propositions": [
    {"from":"c1","phrase":"exige conocer","to":"c2"},
    {"from":"c2","phrase":"se concreta en","to":"c3"}
  ]
}

REGLAS OBLIGATORIAS:
1. Cada proposición (arista) DEBE llevar una FRASE DE ENLACE significativa: verbos o expresiones conectoras como "exige conocer", "se aplica a", "se lleva a cabo a través de", "se concibe como", "incluye", "depende de", "en donde debe constatarse", "se complementa con", "debemos trabajar en base a", "se define por", "se concreta en", "se traduce en", "está formado por", "responde a", "tiene como objetivo". NUNCA uses frases vacías, "es", "tiene", "de", "y", ni inventes "rama" o "subnodo".
2. Las tripletas (concepto A — frase — concepto B) deben leerse como ORACIONES con sentido en castellano.
3. Conceptos de NIVEL 0 = MACROCONCEPTOS o temas principales del documento (texto en MAYÚSCULAS, 3-6 palabras). Conecta los macroconceptos entre sí cuando exista relación (cross-link de nivel 0 a nivel 0).
4. Conceptos de NIVEL 1 = subtemas inmediatos (capitalización normal, 2-4 palabras).
5. Conceptos de NIVEL 2 = subnodos finales (1-3 palabras).
6. Permite cross-links: que un mismo concepto reciba flechas de varios padres, o que conceptos de distintas ramas se conecten entre sí (es lo que distingue un mapa Novak de un árbol).
7. Los IDs son únicos (c1, c2, c3…) y todas las proposiciones referencian conceptos que existan en el array "concepts".
8. Cuando un MISMO concepto origen conecte con varios destinos a través de la MISMA frase de enlace, repite la frase tal cual en cada proposición (el render las agrupa automáticamente).
9. Fuente: EXCLUSIVAMENTE el contenido del documento proporcionado.

ESTRUCTURA OBJETIVO: ${dm[depth] || dm.completo}`;
  try {
    let raw = await callClaude(makeMessages(prompt, topic), 8000);
    raw = raw.replace(/```json|```/g,'').trim();
    const s = raw.indexOf('{'), e = raw.lastIndexOf('}') + 1;
    if (s >= 0) raw = raw.substring(s, e);
    const data = JSON.parse(raw);
    if (!data.title || !Array.isArray(data.concepts) || !Array.isArray(data.propositions)) throw new Error('JSON inválido: faltan concepts o propositions');
    if (!data.concepts.length) throw new Error('Sin conceptos');
    // Validar referencias: descartar proposiciones rotas o reflexivas
    const ids = new Set(data.concepts.map(c => c.id));
    data.propositions = data.propositions.filter(p => p && p.from && p.to && ids.has(p.from) && ids.has(p.to) && p.from !== p.to);
    if (!data.propositions.length) throw new Error('Sin proposiciones válidas');
    return res.json({ success:true, style:'novak', data });
  } catch(err) {
    console.error('[map novak] error:', err.message);
    return res.status(500).json({ error:'No se pudo generar el mapa.' });
  }
});

// ── POST /api/maqueta (SSE) — maquetación con chunking PARALELO + normalización
app.post('/api/maqueta', aiLimiter, async (req, res) => {
  res.setHeader('Content-Type','text/event-stream');
  res.setHeader('Cache-Control','no-cache');
  res.setHeader('Connection','keep-alive');
  res.setHeader('X-Accel-Buffering','no');
  res.flushHeaders();

  // Si el cliente cierra la pestaña, dejamos de invocar a Claude para no gastar tokens.
  let clientAborted = false;
  req.on('close', () => { clientAborted = true; });

  const send = d => {
    if (clientAborted) return;
    try { res.write(`data: ${JSON.stringify(d)}\n\n`); } catch(_){}
  };
  const { topicId } = req.body || {};
  const topic = getOwnedTopic(req, topicId);
  if (!topic) { send({type:'error',message:'Tema no encontrado.'}); return res.end(); }

  const hasImages = topic.images?.length > 0;
  const hasTables = topic.tables?.length > 0;
  const textLength = topic.text?.length || 0;
  const useChunking = textLength > MAQ_SINGLE;

  try {
    if (!useChunking) {
      // Documento pequeño o PDF nativo: llamada única. Pasamos el texto íntegro
      // (sin truncar a MAX_CHARS, que es para preguntas/quiz pero NO para maquetación).
      send({ type:'start', mode:'single', totalChunks:1 });
      send({ type:'progress', chunk:1, total:1, pct:20, label:'Analizando estructura del documento...' });
      const prompt = buildMaquetaPrompt({ hasImages, hasTables, chunkMode:false });
      // Heartbeat: cada ~5s mientras Claude responde, mandamos progreso al cliente
      // para que el SSE no entre en idle y el router HAProxy no corte la conexión.
      const onTick = (chars) => {
        const approxPct = Math.min(80, 20 + Math.round(chars / 200));
        send({ type:'progress', chunk:1, total:1, pct: approxPct, label: `Maquetando… (${chars.toLocaleString()} caracteres generados)` });
      };
      const raw = await callClaude(makeMessages(prompt, topic, null, { fullText: true }), MAQ_MAX_TOKENS, onTick);
      send({ type:'progress', chunk:1, total:1, pct:85, label:'Procesando respuesta...' });
      let data = parseMaqJson(raw);
      data = normalizeMaquetaData(data, {
        imgCount: topic.images?.length || 0,
        tblCount: topic.tables?.length || 0
      });
      const stats = (data.blocks || []).reduce((s,b) => { s[b.t] = (s[b.t]||0) + 1; return s; }, {});
      send({
        type:'complete',
        data,
        stats,
        truncated: topic.type === 'docx' && (topic.text?.length || 0) > MAX_CHARS && !useChunking,
        hasImages, hasTables,
        mode:'single'
      });
      return res.end();
    }

    // Documento grande: chunking PARALELO sobre texto extraído
    if (!topic.text) {
      send({ type:'error', message:'No se pudo extraer texto del documento para procesarlo en secciones.' });
      return res.end();
    }

    const chunks = splitIntoChunks(topic.text, MAQ_CHUNK);
    // Si el split devuelve sólo 1 chunk (texto entre MAQ_SINGLE y MAQ_CHUNK), tratamos como single
    // — el prompt en chunkMode confunde al modelo cuando hay una sola "sección".
    const useChunkMode = chunks.length > 1;
    send({ type:'start', mode: useChunkMode ? 'chunked' : 'single-from-chunked', totalChunks:chunks.length, textLength, pages:topic.pages||null });

    // Procesar chunks con concurrencia limitada para acelerar el maquetado
    const CONCURRENCY = parseInt(process.env.MAQ_CONCURRENCY || '3');
    const results = new Array(chunks.length);
    let completed = 0;
    let nextIdx = 0;
    async function worker() {
      while (nextIdx < chunks.length) {
        if (clientAborted) return; // cliente cerró → no consumir más Claude API
        const i = nextIdx++;
        send({
          type:'progress',
          chunk: i+1,
          total: chunks.length,
          pct: Math.round((completed / chunks.length) * 92) + 4,
          label: useChunkMode ? `Maquetando sección ${i+1} de ${chunks.length}...` : 'Maquetando documento...'
        });
        const chunkPrompt = buildMaquetaPrompt({
          hasImages, hasTables,
          chunkMode: useChunkMode,
          chunkInfo: useChunkMode ? `sección ${i+1} de ${chunks.length}` : null
        });
        const msg = [{ role:'user', content:`CONTENIDO DE "${topic.name}"${useChunkMode ? ` (sección ${i+1}/${chunks.length})` : ''}:\n---\n${chunks[i]}\n---\n\n${chunkPrompt}` }];
        // Heartbeat: mientras este chunk corre, reportar al cliente que sigue vivo.
        const onTick = (chars) => {
          send({
            type:'progress',
            chunk: i+1,
            total: chunks.length,
            pct: Math.round((completed / chunks.length) * 92) + 4,
            label: `Sección ${i+1}/${chunks.length} · ${chars.toLocaleString()} caracteres generados`
          });
        };
        // Hasta 2 reintentos si el parsing falla (max_tokens, JSON malformado puntual)
        let lastErr = null, data = null;
        for (let attempt = 0; attempt < 2 && !data; attempt++) {
          try {
            const raw = await callClaude(msg, MAQ_MAX_TOKENS, onTick);
            data = parseMaqJson(raw);
          } catch (e) {
            lastErr = e;
            console.warn(`[maqueta] chunk ${i+1} intento ${attempt+1} falló: ${e.message}`);
          }
        }
        if (data) {
          results[i] = data;
          if (data._truncated) {
            send({ type:'chunk_warning', chunk:i+1, message:'Sección recuperada parcialmente (output truncado).' });
          }
        } else {
          // Última línea de defensa: bloque fallback con el texto crudo del chunk para no perderlo.
          send({ type:'chunk_error', chunk:i+1, message:`No se pudo maquetar esta sección: ${lastErr?.message || 'error desconocido'}. Se conservará el texto crudo.` });
          results[i] = {
            title: '',
            blocks: [
              { t: 'h2', n: '', text: `Sección ${i+1} (sin maquetar).` },
              { t: 'p', text: `⚠ Esta sección no se pudo maquetar automáticamente; se conserva el texto original a continuación.` },
              { t: 'p', text: chunks[i].substring(0, 8000) }
            ],
            _failed: true
          };
        }
        completed++;
        send({
          type:'progress',
          chunk: completed,
          total: chunks.length,
          pct: Math.round((completed / chunks.length) * 92) + 4,
          label: `Sección ${completed}/${chunks.length} completada.`
        });
      }
    }
    const workers = [];
    for (let w = 0; w < Math.min(CONCURRENCY, chunks.length); w++) workers.push(worker());
    await Promise.all(workers);

    // Reportar al frontend cuántas secciones quedaron incompletas
    const failedCount = results.filter(r => r && r._failed).length;
    const truncatedCount = results.filter(r => r && r._truncated).length;

    // Si TODOS los chunks fallaron, no devolvemos un docx degradado silenciosamente:
    // emitimos error explícito para que el cliente lo muestre y no genere un docx
    // que sólo contiene texto crudo de fallback.
    if (failedCount === chunks.length && failedCount > 0) {
      send({ type:'error', message: 'No se pudo maquetar ninguna sección. Revisa la conexión con Claude.' });
      return res.end();
    }

    // Unificar resultados conservando el ORDEN de los chunks
    const allBlocks = [];
    let finalTitle = '';
    for (let i = 0; i < results.length; i++) {
      const r = results[i] || { blocks: [] };
      if (i === 0 && r.title) finalTitle = r.title;
      if (Array.isArray(r.blocks)) allBlocks.push(...r.blocks);
    }

    let finalData = {
      title: finalTitle || topic.name.replace(/\.[^.]+$/,''),
      blocks: allBlocks
    };
    finalData = normalizeMaquetaData(finalData, {
      imgCount: topic.images?.length || 0,
      tblCount: topic.tables?.length || 0
    });

    const stats = finalData.blocks.reduce((s,b) => { s[b.t] = (s[b.t]||0) + 1; return s; }, {});
    send({
      type:'complete',
      data: finalData,
      stats,
      truncated: failedCount > 0 || truncatedCount > 0,
      failedChunks: failedCount,
      truncatedChunks: truncatedCount,
      hasImages, hasTables,
      mode:'chunked',
      processedChunks: chunks.length
    });
    res.end();
  } catch(err) {
    console.error('[maqueta] error:', err.message);
    // El cliente recibe el mensaje compacto (callClaude ya filtra detalles sensibles).
    send({ type:'error', message: `Error procesando la maquetación: ${err.message}` });
    res.end();
  }
});

// ── POST /api/maqueta-batch (SSE) — varios temas en serie ─────────────────────
app.post('/api/maqueta-batch', aiLimiter, async (req, res) => {
  res.setHeader('Content-Type','text/event-stream');
  res.setHeader('Cache-Control','no-cache');
  res.setHeader('Connection','keep-alive');
  res.setHeader('X-Accel-Buffering','no');
  res.flushHeaders();

  let clientAborted = false;
  req.on('close', () => { clientAborted = true; });

  const send = d => {
    if (clientAborted) return;
    try { res.write(`data: ${JSON.stringify(d)}\n\n`); } catch(_){}
  };
  const { topicIds } = req.body || {};
  if (!Array.isArray(topicIds) || !topicIds.length) {
    send({type:'error', message:'Sin documentos seleccionados.'});
    return res.end();
  }
  if (topicIds.length > MAX_TOPICS) { send({type:'error', message:'Demasiados temas.'}); return res.end(); }
  const topics = topicIds.filter(id => typeof id === "string").map(id => getOwnedTopic(req, id)).filter(Boolean);
  if (!topics.length) { send({type:'error', message:'Temas no encontrados.'}); return res.end(); }

  send({ type:'batch_start', total: topics.length });
  const results = [];

  for (let ti = 0; ti < topics.length; ti++) {
    if (clientAborted) break;
    const topic = topics[ti];
    send({ type:'topic_start', ti, name:topic.name, total: topics.length });

    const hasImages = topic.images?.length > 0;
    const hasTables = topic.tables?.length > 0;
    const textLength = topic.text?.length || 0;
    const useChunking = textLength > MAQ_SINGLE;

    try {
      let finalData;
      if (!useChunking) {
        send({ type:'topic_progress', ti, pct:30, label:'Analizando estructura...' });
        const prompt = buildMaquetaPrompt({ hasImages, hasTables, chunkMode:false });
        const onTick = (chars) => send({
          type:'topic_progress', ti,
          pct: Math.min(75, 30 + Math.round(chars / 400)),
          label: `Maquetando… (${chars.toLocaleString()} caracteres)`
        });
        const raw = await callClaude(makeMessages(prompt, topic, null, { fullText: true }), MAQ_MAX_TOKENS, onTick);
        const data = parseMaqJson(raw);
        send({ type:'topic_progress', ti, pct:80, label:'Normalizando resultado...' });
        finalData = normalizeMaquetaData(data, {
          imgCount: topic.images?.length || 0,
          tblCount: topic.tables?.length || 0
        });
      } else {
        const chunks = splitIntoChunks(topic.text, MAQ_CHUNK);
        const useChunkMode = chunks.length > 1;
        send({ type:'topic_progress', ti, pct:5, label: useChunkMode ? `Documento grande · ${chunks.length} secciones.` : 'Maquetando documento...' });
        const CONCURRENCY = parseInt(process.env.MAQ_CONCURRENCY || '3');
        const arr = new Array(chunks.length);
        let completed = 0, nextIdx = 0;
        async function worker() {
          while (nextIdx < chunks.length) {
            if (clientAborted) return;
            const i = nextIdx++;
            const chunkPrompt = buildMaquetaPrompt({
              hasImages, hasTables, chunkMode: useChunkMode,
              chunkInfo: useChunkMode ? `sección ${i+1} de ${chunks.length}` : null
            });
            const msg = [{ role:'user', content:`CONTENIDO DE "${topic.name}"${useChunkMode ? ` (sección ${i+1}/${chunks.length})` : ''}:\n---\n${chunks[i]}\n---\n\n${chunkPrompt}` }];
            const onTick = (chars) => send({
              type:'topic_progress', ti,
              pct: 5 + Math.round((completed / chunks.length) * 85),
              label: `Sección ${i+1}/${chunks.length} · ${chars.toLocaleString()} caracteres`
            });
            let lastErr = null, data = null;
            for (let attempt = 0; attempt < 2 && !data; attempt++) {
              try {
                const raw = await callClaude(msg, MAQ_MAX_TOKENS, onTick);
                data = parseMaqJson(raw);
              } catch(e) { lastErr = e; }
            }
            if (data) arr[i] = data;
            else arr[i] = {
              title: '',
              blocks: [
                { t: 'h2', n: '', text: `Sección ${i+1} (sin maquetar).` },
                { t: 'p', text: `⚠ No se pudo maquetar automáticamente esta sección (${lastErr?.message || 'error'}). Texto original a continuación.` },
                { t: 'p', text: chunks[i].substring(0, 8000) }
              ],
              _failed: true
            };
            completed++;
            send({ type:'topic_progress', ti,
              pct: 5 + Math.round((completed / chunks.length) * 85),
              label: `Sección ${completed}/${chunks.length}` });
          }
        }
        const workers = [];
        for (let w = 0; w < Math.min(CONCURRENCY, chunks.length); w++) workers.push(worker());
        await Promise.all(workers);
        const allBlocks = [];
        let finalTitle = '';
        const failed = arr.filter(r => r && r._failed).length;
        const truncated = arr.filter(r => r && r._truncated).length;
        for (let i = 0; i < arr.length; i++) {
          const r = arr[i] || { blocks: [] };
          if (i === 0 && r.title) finalTitle = r.title;
          if (Array.isArray(r.blocks)) allBlocks.push(...r.blocks);
        }
        finalData = normalizeMaquetaData({
          title: finalTitle || topic.name.replace(/\.[^.]+$/,''),
          blocks: allBlocks
        }, {
          imgCount: topic.images?.length || 0,
          tblCount: topic.tables?.length || 0
        });
        finalData._failedChunks = failed;
        finalData._truncatedChunks = truncated;
      }

      const stats = finalData.blocks.reduce((s,b) => { s[b.t] = (s[b.t]||0) + 1; return s; }, {});
      results.push({ topicId: topic.id, name: topic.name, data: finalData, stats });
      send({ type:'topic_complete', ti, name:topic.name, data:finalData, stats, hasImages, hasTables, failedChunks: finalData._failedChunks || 0, truncatedChunks: finalData._truncatedChunks || 0 });
    } catch(err) {
      send({ type:'topic_error', ti, name:topic.name, message:err.message });
    }
  }

  send({ type:'batch_complete', total: topics.length, results });
  res.end();
});

// ── POST /api/maqueta-zip — empaqueta varios .docx maquetados en un ZIP ──────
app.post('/api/maqueta-zip', async (req, res) => {
  const { items, templateId, colors } = req.body || {};
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error:'Sin documentos.' });
  if (items.length > MAX_TOPICS) return res.status(400).json({ error:'Demasiados documentos.' });

  // Resolver colores comunes para todo el lote
  let finalColors = null;
  if (colors && typeof colors === 'object') {
    finalColors = { ...DEFAULT_TEMPLATES[0].colors, ...colors };
  } else if (templateId) {
    const tpls = getUserTemplates(req.user.id);
    const t = tpls.find(x => x.id === templateId);
    if (t) finalColors = t.colors;
  }

  try {
    const zip = new JSZip();
    for (const it of items) {
      const { data, topicId, quiz } = it;
      if (!data || !Array.isArray(data.blocks)) continue;
      const topic = topicId ? getOwnedTopic(req, topicId) : null;
      const imageStore = topic?.images || null;
      const tableStore = topic?.tables || null;

      let cleanQuiz = null;
      if (quiz && Array.isArray(quiz.questions) && quiz.questions.length) {
        cleanQuiz = {
          type: ['vf','3opt','4opt'].includes(quiz.type) ? quiz.type : '4opt',
          mode: ['inline','end'].includes(quiz.mode) ? quiz.mode : 'end',
          questions: quiz.questions
        };
        if (cleanQuiz.mode === 'inline') {
          data.blocks = distributeInlineQuiz(data.blocks, cleanQuiz.questions.length);
        }
      }

      const doc = buildMaquetadoDoc(data, imageStore, tableStore, finalColors, cleanQuiz);
      const buf = await Packer.toBuffer(doc);
      const safe = (data.title || topic?.name || 'documento')
        .replace(/\.[^.]+$/, '')
        .replace(/[^\w\-áéíóúüñÁÉÍÓÚÜÑ ]/g,'_')
        .substring(0,60).trim() || 'documento';
      zip.file(`${safe}_maquetado.docx`, buf);
    }
    const buf = await zip.generateAsync({ type:'nodebuffer', compression:'DEFLATE' });
    res.setHeader('Content-Type','application/zip');
    res.setHeader('Content-Disposition','attachment; filename="maquetados.zip"');
    res.send(buf);
  } catch(err) {
    console.error('[maqueta-zip] error:', err.message);
    res.status(500).json({ error:'Error generando el ZIP.' });
  }
});

// ── POST /api/maqueta-quiz — genera autoevaluación integrada en JSON ─────────
app.post('/api/maqueta-quiz', aiLimiter, async (req, res) => {
  const { topicId, type, num, diff } = req.body || {};
  const topic = getOwnedTopic(req, topicId);
  if (!topic) return res.status(404).json({ error:'Tema no encontrado.' });
  const cleanType = ['vf','3opt','4opt'].includes(type) ? type : '4opt';
  const cleanDiff = ['bajo','medio','alto'].includes(diff) ? diff : 'medio';
  const cleanNum  = Math.max(3, Math.min(30, parseInt(num) || 10));

  const numOpts = cleanType === 'vf' ? 2 : cleanType === '3opt' ? 3 : 4;
  const letters = LETTERS.slice(0, numOpts);
  const dM = {
    bajo:  'BAJA — definiciones, conceptos directos del contenido.',
    medio: 'MEDIA — comprensión, aplicación, distinciones entre ideas próximas.',
    alto:  'ALTA — análisis, síntesis, supuestos complejos. Todas las opciones plausibles.'
  };

  let prompt;
  if (cleanType === 'vf') {
    prompt = `Genera EXACTAMENTE ${cleanNum} preguntas de tipo VERDADERO / FALSO en ESPAÑOL, basadas EXCLUSIVAMENTE en el contenido proporcionado.
Estilo de oposición real. Dificultad: ${dM[cleanDiff]}.

REGLAS:
- Cada pregunta es UNA AFIRMACIÓN clara. El alumno debe juzgar si es verdadera o falsa.
- Distribución equilibrada: aproximadamente la mitad verdaderas y la mitad falsas.
- Cada afirmación debe ser ÚNICA en concepto y formulación. PROHIBIDO repetir estructuras o enfocar el mismo concepto desde otro ángulo.
- No uses metarreferencias ("según el texto", "el documento dice...", etc.).
- Evita ambigüedades: una afirmación es claramente V o claramente F.
- No incluyas explicaciones largas; sí una breve justificación de una sola línea.

Devuelve ÚNICAMENTE JSON válido (sin texto antes ni después, sin \`\`\`json):
{"questions":[{"q":"Afirmación a juzgar.","correct":true,"explanation":"Justificación breve."}]}
"correct" es un booleano (true=verdadero, false=falso).`;
  } else {
    prompt = `Genera EXACTAMENTE ${cleanNum} preguntas tipo test de ${numOpts} opciones (${letters.join(', ')}) en ESPAÑOL, basadas EXCLUSIVAMENTE en el contenido proporcionado.
Estilo de oposición real. SOLO UNA opción correcta por pregunta. Dificultad: ${dM[cleanDiff]}.

REGLAS DE CALIDAD:
- Cada pregunta debe ser ÚNICA en concepto, enfoque y estructura. PROHIBIDO repetir el mismo molde de enunciado más de una vez (no abuses de "¿Cuál es el objetivo de…?", "¿Qué establece…?", etc.).
- Las ${numOpts} opciones deben ser todas plausibles, de longitud similar, sin pistas léxicas.
- No uses "todas las anteriores" ni "ninguna de las anteriores".
- Distribuye la respuesta correcta entre las distintas letras (no concentres todas en A).
- No uses metarreferencias ("según el texto", "el documento dice...", etc.); pregunta directamente.
- Justificación breve de la respuesta correcta (una línea).

Devuelve ÚNICAMENTE JSON válido (sin texto antes ni después, sin \`\`\`json):
{"questions":[{"q":"Enunciado","options":[${letters.map((_,i)=>`"Opción ${i+1}"`).join(',')}],"correct":0,"explanation":"Breve justificación."}]}
"correct" es el ÍNDICE 0..${numOpts-1} de la opción correcta.`;
  }

  try {
    const raw = await callClaude(makeMessages(prompt, topic), 8000);
    let s = raw.replace(/```json|```/g,'').trim();
    const si = s.indexOf('{'), ei = s.lastIndexOf('}') + 1;
    if (si >= 0 && ei > si) s = s.substring(si, ei);
    const data = JSON.parse(s);
    if (!Array.isArray(data.questions)) throw new Error('Respuesta sin questions[].');
    // Saneamiento
    const questions = data.questions.slice(0, cleanNum).map(q => {
      if (cleanType === 'vf') {
        return { q: String(q.q || '').trim(), correct: !!q.correct, explanation: String(q.explanation || '').trim() };
      }
      const opts = Array.isArray(q.options) ? q.options.slice(0, numOpts).map(o => String(o).trim()) : [];
      let c = parseInt(q.correct);
      if (isNaN(c) || c < 0 || c >= opts.length) c = 0;
      return { q: String(q.q || '').trim(), options: opts, correct: c, explanation: String(q.explanation || '').trim() };
    }).filter(q => q.q.length > 5 && (cleanType === 'vf' || (q.options && q.options.length === numOpts)));
    res.json({ success:true, type:cleanType, diff:cleanDiff, questions });
  } catch(err) {
    console.error('[maqueta-quiz] error:', err.message);
    res.status(500).json({ error:'No se pudo generar la autoevaluación.' });
  }
});

// ── POST /api/maqueta-docx — genera Word con plantilla de color ──────────────
app.post('/api/maqueta-docx', async (req, res) => {
  const { data, topicId, templateId, colors, quiz } = req.body || {};
  if (!data || !Array.isArray(data.blocks)) return res.status(400).json({ error:'Sin datos.' });
  try {
    const topic = topicId ? getOwnedTopic(req, topicId) : null;
    const imageStore = topic?.images || null;
    const tableStore = topic?.tables || null;

    // Resolver colores: custom > templateId > defecto
    let finalColors = null;
    if (colors && typeof colors === 'object') {
      finalColors = { ...DEFAULT_TEMPLATES[0].colors, ...colors };
    } else if (templateId) {
      const tpls = getUserTemplates(req.user.id);
      const t = tpls.find(x => x.id === templateId);
      if (t) finalColors = t.colors;
    }

    // Saneamiento del quiz si viene en el body
    let cleanQuiz = null;
    if (quiz && Array.isArray(quiz.questions) && quiz.questions.length) {
      cleanQuiz = {
        type: ['vf','3opt','4opt'].includes(quiz.type) ? quiz.type : '4opt',
        mode: ['inline','end'].includes(quiz.mode) ? quiz.mode : 'end',
        questions: quiz.questions
      };
      if (cleanQuiz.mode === 'inline') {
        // Insertamos marcadores qmarker en posiciones repartidas
        data.blocks = distributeInlineQuiz(data.blocks, cleanQuiz.questions.length);
      }
    }

    const doc = buildMaquetadoDoc(data, imageStore, tableStore, finalColors, cleanQuiz);
    const buf = await Packer.toBuffer(doc);
    const safe = (data.title || 'documento')
      .replace(/[^\w\-áéíóúüñÁÉÍÓÚÜÑ ]/g,'_')
      .substring(0,60).trim();
    res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition',`attachment; filename="${safe}_maquetado.docx"`);
    res.send(buf);
  } catch(err) {
    console.error('[maqueta-docx] error:', err.message);
    res.status(500).json({ error:'Error generando el documento.' });
  }
});

// Corrige mojibake de UTF-8 mal interpretado como Latin-1 (típico en filenames de multer
// cuando el navegador envía el Content-Disposition sin charset). Ej: "tecnologías" llega
// como "tecnologÃ­as" (bytes UTF-8 leídos byte-a-byte como Latin-1).
function fixMojibake(s) {
  if (typeof s !== 'string' || !s) return s;
  // 1. Normalizar a NFC para corregir formas descompuestas que envía macOS Finder
  //    (p.ej. "organizacioÌ n" — "o" + U+0301 combining acute — → "organización").
  //    Esto es seguro: si ya está en NFC, normalize() no cambia nada.
  s = s.normalize('NFC');

  // 2. Si tiene marcadores típicos de mojibake (Ã seguido de ASCII low-ish) y al
  //    re-decodificar como UTF-8 sale algo "más limpio", devolvemos esa versión.
  if (!/[ÃÂ]/.test(s)) return s;
  try {
    const decoded = Buffer.from(s, 'latin1').toString('utf8').normalize('NFC');
    const before = (s.match(/[ÃÂ]/g) || []).length;
    const after  = (decoded.match(/[ÃÂ]/g) || []).length;
    if (after < before && /[áéíóúñÁÉÍÓÚÑ¿¡]/.test(decoded)) return decoded;
  } catch(_) {}
  return s;
}

// Sanitiza un nombre de fichero para evitar path traversal y caracteres peligrosos
function sanitizeFilename(raw, fallback = 'archivo') {
  let name = String(raw || '').trim();
  // Quitar separadores de ruta y caracteres no imprimibles
  name = name.replace(/[\\\/\x00-\x1f]/g, '_');
  // Quitar prefijos ".." sucesivos
  name = name.replace(/^(\.+[\\\/])+/, '').replace(/\.\.+/g, '.');
  // Whitelist conservadora: letras, números, _ - . espacio y vocales acentuadas comunes
  name = name.replace(/[^\w\-. áéíóúüñÁÉÍÓÚÜÑ]/g, '_');
  name = name.substring(0, 80).trim();
  return name || fallback;
}

app.post('/api/zip', async (req, res) => {
  const { files } = req.body || {};
  if (!Array.isArray(files) || !files.length) return res.status(400).json({ error:'Sin archivos' });
  if (files.length > 200) return res.status(400).json({ error:'Demasiados archivos.' });

  const MAX_TOTAL_BYTES = 100 * 1024 * 1024; // 100 MB total
  let total = 0;
  try {
    const zip = new JSZip();
    for (const f of files) {
      if (!f || typeof f.name !== 'string' || !('content' in f)) continue;
      const safeName = sanitizeFilename(f.name, 'archivo');
      let content = f.content;
      // Aceptamos string, Array de bytes o Uint8Array serializado a array
      if (Array.isArray(content)) content = Buffer.from(content);
      else if (typeof content === 'string') content = Buffer.from(content, 'utf8');
      else continue;
      total += content.length;
      if (total > MAX_TOTAL_BYTES) {
        return res.status(413).json({ error: 'El paquete excede el tamaño máximo permitido.' });
      }
      zip.file(safeName, content);
    }
    const buf = await zip.generateAsync({ type:'nodebuffer', compression:'DEFLATE' });
    res.setHeader('Content-Type','application/zip');
    res.setHeader('Content-Disposition','attachment; filename="exportacion.zip"');
    res.send(buf);
  } catch(err) {
    console.error('[zip] error:', err.message);
    res.status(500).json({ error:'Error generando el ZIP.' });
  }
});

// ── HISTORIAL por usuario ─────────────────────────────────────────────────────
// GET → listar últimas entradas (sin contenido pesado)
app.get('/api/history', (req, res) => {
  const { type } = req.query;
  let list = loadHistory(req.user.id);
  if (type) list = list.filter(e => e.type === type);
  // Versión ligera: sin el campo `content` para la lista
  const lite = list.map(({ content, ...rest }) => ({
    ...rest,
    hasContent: !!content,
    size: content ? JSON.stringify(content).length : 0
  }));
  res.json(lite);
});

// GET /:id → detalle completo (con contenido)
app.get('/api/history/:id', (req, res) => {
  const list = loadHistory(req.user.id);
  const entry = list.find(e => e.id === req.params.id);
  if (!entry) return res.status(404).json({ error:'Entrada no encontrada.' });
  res.json(entry);
});

// POST → crear entrada
app.post('/api/history', (req, res) => {
  const { type, title, meta, content } = req.body;
  if (!type || !title) return res.status(400).json({ error:'Faltan campos type/title.' });
  const valid = ['questions','summary','map','maqueta'];
  if (!valid.includes(type)) return res.status(400).json({ error:'type debe ser: ' + valid.join(', ') });
  const entry = addHistoryEntry(req.user.id, {
    type,
    title: String(title).substring(0, 200),
    meta: meta || {},
    content: content || {}
  });
  const { content: _c, ...lite } = entry;
  res.json({ success:true, entry:lite });
});

// DELETE /:id
app.delete('/api/history/:id', (req, res) => {
  const list = loadHistory(req.user.id);
  const idx = list.findIndex(e => e.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error:'Entrada no encontrada.' });
  list.splice(idx, 1);
  saveHistory(req.user.id, list);
  res.json({ success:true });
});

// DELETE (vaciar todo con ?type=xxx opcional)
app.delete('/api/history', (req, res) => {
  const { type } = req.query;
  if (type) {
    const list = loadHistory(req.user.id).filter(e => e.type !== type);
    saveHistory(req.user.id, list);
  } else {
    saveHistory(req.user.id, []);
  }
  res.json({ success:true });
});

// ── PLANTILLAS DE COLOR por usuario ───────────────────────────────────────────
// GET → listar plantillas (defecto + personales)
app.get('/api/templates', (req, res) => {
  res.json(getUserTemplates(req.user.id));
});

// POST → crear/actualizar plantilla personal
app.post('/api/templates', (req, res) => {
  const { id, name, colors } = req.body;
  if (!name || !colors || typeof colors !== 'object') {
    return res.status(400).json({ error:'Nombre y colores son obligatorios.' });
  }
  // Validar formato hex de cada color
  const validKeys = ['h1','h2','h3','lineH1','lineH2','title','body','header','brd'];
  const cleanColors = {};
  for (const k of validKeys) {
    const v = colors[k];
    if (typeof v === 'string' && /^[0-9A-Fa-f]{6}$/.test(v.replace('#',''))) {
      cleanColors[k] = v.replace('#','').toUpperCase();
    }
  }
  if (Object.keys(cleanColors).length === 0) {
    return res.status(400).json({ error:'Debes aportar al menos un color válido (hex de 6 dígitos).' });
  }
  const stored = loadTemplates(req.user.id) || [];
  const now = new Date().toISOString();
  if (id) {
    // Actualizar existente (solo si es personal, no built-in)
    if (id.startsWith('default-')) return res.status(400).json({ error:'No se puede modificar una plantilla por defecto. Guarda como nueva.' });
    const idx = stored.findIndex(t => t.id === id);
    if (idx === -1) return res.status(404).json({ error:'Plantilla no encontrada.' });
    stored[idx] = { ...stored[idx], name:name.trim().substring(0,60), colors:cleanColors, updatedAt:now };
    saveTemplates(req.user.id, stored);
    return res.json({ success:true, template:stored[idx] });
  }
  const newT = {
    id: uuidv4(),
    name: name.trim().substring(0, 60),
    colors: cleanColors,
    createdAt: now,
    updatedAt: now
  };
  stored.push(newT);
  saveTemplates(req.user.id, stored);
  res.json({ success:true, template:newT });
});

// DELETE /:id → solo personales
app.delete('/api/templates/:id', (req, res) => {
  const { id } = req.params;
  if (id.startsWith('default-')) return res.status(400).json({ error:'No se puede eliminar una plantilla por defecto.' });
  const stored = loadTemplates(req.user.id) || [];
  const next = stored.filter(t => t.id !== id);
  if (next.length === stored.length) return res.status(404).json({ error:'Plantilla no encontrada.' });
  saveTemplates(req.user.id, next);
  res.json({ success:true });
});

// ── Moodle API (Moodle 4.1+ / Moodle 5) ──────────────────────────────────────
// Comprueba si una IP es privada / loopback / link-local / unique-local IPv6.
function isPrivateIp(ip) {
  if (!ip) return true;
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    const [a,b] = parts;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a >= 224) return true;            // multicast / reserved
    return false;
  }
  if (net.isIPv6(ip)) {
    const norm = ip.toLowerCase();
    if (norm === '::1' || norm === '::') return true;
    if (norm.startsWith('fe80:')) return true;     // link-local
    if (/^f[cd][0-9a-f]{2}:/.test(norm)) return true; // ULA fc00::/7
    if (norm.startsWith('ff')) return true;        // multicast
    if (norm.startsWith('::ffff:')) {              // IPv4-mapped
      return isPrivateIp(norm.split('::ffff:')[1]);
    }
    return false;
  }
  return true;
}

// Resuelve un URL externo y rechaza destinos privados/loopback (anti-SSRF).
async function assertSafeExternalUrl(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch(_) { throw new Error('URL inválida.'); }
  if (u.protocol !== 'https:') throw new Error('La URL debe usar HTTPS.');
  if (!u.hostname) throw new Error('URL sin host.');
  // Si ya es IP literal, valida directamente
  if (net.isIP(u.hostname)) {
    if (isPrivateIp(u.hostname)) throw new Error('Dirección de red no permitida.');
    return u;
  }
  // Resolver DNS y rechazar si alguna IP es privada (mitiga DNS rebinding parcial)
  let addrs;
  try { addrs = await dns.lookup(u.hostname, { all: true }); }
  catch(_) { throw new Error('No se pudo resolver el dominio.'); }
  for (const a of addrs) {
    if (isPrivateIp(a.address)) throw new Error('El dominio resuelve a una red interna no permitida.');
  }
  return u;
}

async function callMoodle(baseUrl, token, wsfunction, params={}) {
  // Validar URL antes de cualquier fetch
  const u = await assertSafeExternalUrl(baseUrl);
  const endpoint = `${u.origin}${u.pathname.replace(/\/+$/,'')}/webservice/rest/server.php`;
  const body = new URLSearchParams({ wstoken:token, wsfunction, moodlewsrestformat:'json', ...params });
  const response = await fetch(endpoint, {
    method: 'POST',
    body: body.toString(),
    headers: { 'Content-Type':'application/x-www-form-urlencoded' },
    signal: AbortSignal.timeout(30000),
    redirect: 'error'      // sin seguir redirecciones (evita bypass del filtro)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  if (data?.exception) throw new Error(data.message || 'Error de Moodle');
  if (data?.error) throw new Error('Error de Moodle');
  return data;
}

app.post('/api/moodle/test', async (req, res) => {
  const { url, token } = req.body || {};
  if (typeof url !== 'string' || typeof token !== 'string' || !url || !token) {
    return res.status(400).json({ error:'URL y token obligatorios.' });
  }
  try {
    const info = await callMoodle(url, token, 'core_webservice_get_site_info');
    res.json({
      success:true,
      sitename:info.sitename, release:info.release, version:info.version,
      userid:info.userid, username:info.username, fullname:info.fullname
    });
  } catch(err) {
    console.warn('[moodle/test] error:', err.message);
    res.status(400).json({ error:'No se pudo conectar con el servidor Moodle.' });
  }
});

app.post('/api/moodle/courses', async (req, res) => {
  const { url, token, userid } = req.body || {};
  if (typeof url !== 'string' || typeof token !== 'string' || !url || !token) {
    return res.status(400).json({ error:'URL y token obligatorios.' });
  }
  try {
    let courses;
    if (userid) {
      courses = await callMoodle(url, token, 'core_enrol_get_users_courses', { userid: String(userid) });
    } else {
      courses = await callMoodle(url, token, 'core_course_get_courses');
    }
    const list = (Array.isArray(courses) ? courses : [])
      .filter(c => c.id > 1)
      .map(c => ({ id:c.id, shortname:c.shortname, fullname:c.fullname }));
    res.json({ success:true, courses:list });
  } catch(err) {
    console.warn('[moodle/courses] error:', err.message);
    res.status(400).json({ error:'Error obteniendo cursos.' });
  }
});

app.post('/api/moodle/import', async (req, res) => {
  const { url, token, courseid, giftContent, filename } = req.body || {};
  if (typeof url !== 'string' || typeof token !== 'string' || !url || !token || !courseid || typeof giftContent !== 'string' || !giftContent) {
    return res.status(400).json({ error:'Faltan parámetros.' });
  }
  if (giftContent.length > 5 * 1024 * 1024) {
    return res.status(413).json({ error:'Contenido demasiado grande.' });
  }
  try {
    const fname = (filename || 'banco_preguntas').replace(/[^a-zA-Z0-9_\-]/g,'_').substring(0,60) + '.gift';
    const uploadResult = await callMoodle(url, token, 'core_files_upload', {
      component:'user', filearea:'draft', itemid:'0', filepath:'/',
      filename:fname,
      filecontent: Buffer.from(giftContent, 'utf-8').toString('base64')
    });
    try {
      await callMoodle(url, token, 'qbank_importquestions_import_questions', {
        qformat:'gift',
        courseid: String(courseid),
        draftitemid: String(uploadResult.itemid),
        stoponerror:'0'
      });
      return res.json({ success:true, method:'direct', message:`✓ Banco de preguntas importado correctamente en el curso (ID ${courseid}).` });
    } catch(importErr) {
      console.warn('[moodle/import] manual fallback:', importErr.message);
      return res.json({
        success:true, method:'manual',
        message:`Archivo subido a Moodle. Impórtalo manualmente: Banco de preguntas → Importar → Formato GIFT → seleccionar "${fname}" desde borradores.`
      });
    }
  } catch(err) {
    console.warn('[moodle/import] error:', err.message);
    res.status(400).json({ error:'Error al importar a Moodle.' });
  }
});

// Para rutas con extensión típica de recurso (no SPA), devolver 404. Evita que crawlers
// indexen `index.html` con URLs falsas y reduce confusión para escáneres.
app.get('*', (req, res) => {
  if (/\.[a-zA-Z0-9]{1,8}$/.test(req.path)) return res.status(404).send('Not found');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Arranque ──────────────────────────────────────────────────────────────────
initUsers().then(() => {
  app.listen(PORT, HOST, () => {
    console.log(`\n✅  Suite Académica Moodle · v8.1`);
    console.log(`   URL    : http://${HOST==='0.0.0.0'?'localhost':HOST}:${PORT}`);
    console.log(`   Modelo : ${MODEL}`);
    console.log(`   Usuarios: ${loadUsers().length} registrados`);
    console.log(`   Maquetación: chunk=${MAQ_CHUNK} · single=${MAQ_SINGLE} · concurrencia=${process.env.MAQ_CONCURRENCY || '3'} · historial=${HISTORY_LIMIT}\n`);
  });
});
