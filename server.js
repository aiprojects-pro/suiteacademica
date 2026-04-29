require('dotenv').config();
const express   = require('express');
const session   = require('express-session');
const FileStore = require('session-file-store')(session);
const bcrypt    = require('bcryptjs');
const multer    = require('multer');
const mammoth   = require('mammoth');
const pdfParse  = require('pdf-parse');
const Anthropic = require('@anthropic-ai/sdk');
const JSZip     = require('jszip');
const { v4: uuidv4 } = require('uuid');
const path      = require('path');
const fs        = require('fs');

const {
  Document, Packer, Paragraph, TextRun, ImageRun, HeadingLevel,
  AlignmentType, BorderStyle, Header, Footer, PageNumber, LevelFormat
} = require('docx');

// ── Validaciones de entorno ───────────────────────────────────────────────────
const MISSING = ['ANTHROPIC_API_KEY','SESSION_SECRET'].filter(k=>!process.env[k]);
if (MISSING.length) {
  console.error(`\n❌  Variables de entorno no definidas en .env: ${MISSING.join(', ')}`);
  console.error('    Copia .env.example como .env y completa los valores.\n');
  process.exit(1);
}

// ── Configuración ─────────────────────────────────────────────────────────────
const app  = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT  || 3000;
const HOST = process.env.HOST  || '0.0.0.0';
const MODEL       = process.env.ANTHROPIC_MODEL  || 'claude-sonnet-4-6';
const MAX_TOPICS  = parseInt(process.env.MAX_TOPICS  || '100');
const MAX_FILE_MB = parseInt(process.env.MAX_FILE_MB || '50');
const BATCH_SIZE  = parseInt(process.env.BATCH_SIZE  || '25');
const MAX_CHARS   = parseInt(process.env.MAX_CHARS   || '12000');
const MAQ_CHUNK   = parseInt(process.env.MAQ_CHUNK_CHARS || '25000'); // tamaño de chunk para maquetación
const MAQ_SINGLE  = parseInt(process.env.MAQ_SINGLE_CHARS || '18000'); // umbral para llamada única
const CACHE_TTL   = parseInt(process.env.CACHE_TTL_H || '4') * 3600000;
const SESSION_MS  = parseInt(process.env.SESSION_HOURS || '8') * 3600000;
const HISTORY_LIMIT = parseInt(process.env.HISTORY_LIMIT || '200');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Almacenamiento (users + historial + plantillas) ────────────────────────────
const DATA_DIR        = path.join(__dirname, 'data');
const USERS_FILE      = path.join(DATA_DIR, 'users.json');
const HISTORY_DIR     = path.join(DATA_DIR, 'history');
const TEMPLATES_DIR   = path.join(DATA_DIR, 'templates');
const SESSIONS_DIR    = path.join(DATA_DIR, 'sessions');
if (!fs.existsSync(DATA_DIR))      fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(HISTORY_DIR))   fs.mkdirSync(HISTORY_DIR, { recursive: true });
if (!fs.existsSync(TEMPLATES_DIR)) fs.mkdirSync(TEMPLATES_DIR, { recursive: true });
if (!fs.existsSync(SESSIONS_DIR))  fs.mkdirSync(SESSIONS_DIR, { recursive: true });

function loadUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch(_) { return []; }
}
function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}
function findUser(idOrUsername) {
  const users = loadUsers();
  return users.find(u => u.id === idOrUsername || u.username === idOrUsername) || null;
}

// ── Historial por usuario ─────────────────────────────────────────────────────
function historyPath(uid){ return path.join(HISTORY_DIR, `${uid}.json`); }
function loadHistory(uid){
  try { return JSON.parse(fs.readFileSync(historyPath(uid), 'utf8')); } catch(_) { return []; }
}
function saveHistory(uid, list){
  fs.writeFileSync(historyPath(uid), JSON.stringify(list, null, 2));
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
  fs.writeFileSync(templatesPath(uid), JSON.stringify(list, null, 2));
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
    const adminUser = process.env.ADMIN_USER || 'admin';
    const adminPass = process.env.ADMIN_PASS || 'Admin1234!';
    const hash = await bcrypt.hash(adminPass, 12);
    saveUsers([{
      id:        uuidv4(),
      username:  adminUser,
      name:      'Administrador',
      password:  hash,
      role:      'admin',
      active:    true,
      createdAt: new Date().toISOString(),
      lastLogin: null
    }]);
    console.log(`\n🔑  Usuario administrador creado:`);
    console.log(`     Usuario    : ${adminUser}`);
    console.log(`     Contraseña : ${adminPass}`);
    console.log(`     ⚠  Cambia la contraseña desde el panel de usuarios tras el primer login.\n`);
  }
}

// ── Cache de temas ─────────────────────────────────────────────────────────────
const topicCache = new Map();
setInterval(() => { const n=Date.now(); for(const[id,e] of topicCache) if(n-e.ts>CACHE_TTL) topicCache.delete(id); }, 3600000);

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(session({
  store:             new FileStore({ path: SESSIONS_DIR, ttl: Math.floor(SESSION_MS / 1000), retries: 0 }),
  secret:            process.env.SESSION_SECRET,
  resave:            false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production' && process.env.HTTPS === 'true',
    maxAge:   SESSION_MS
  }
}));
app.use((_req,res,next) => { res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('X-Frame-Options','SAMEORIGIN'); next(); });

// ── Auth helpers ──────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session.userId) {
    const isJson = req.headers['content-type']?.includes('json') || req.xhr;
    return isJson
      ? res.status(401).json({ error:'No autenticado', redirect:'/login' })
      : res.redirect('/login');
  }
  const user = findUser(req.session.userId);
  if (!user || !user.active) {
    req.session.destroy(() => {});
    return res.redirect('/login?msg=session_expired');
  }
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error:'Acceso denegado. Se requiere rol administrador.' });
  next();
}

// ── Rutas de autenticación (sin protección) ────────────────────────────────────
app.get('/login', (req, res) => {
  if (req.session.userId) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error:'Usuario y contraseña son obligatorios.' });

  const user = findUser(username.trim().toLowerCase()) || findUser(username.trim());
  if (!user) return res.status(401).json({ error:'Usuario o contraseña incorrectos.' });
  if (!user.active) return res.status(403).json({ error:'Esta cuenta está desactivada. Contacta con el administrador.' });

  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(401).json({ error:'Usuario o contraseña incorrectos.' });

  req.session.userId = user.id;
  req.session.save(() => {
    const users = loadUsers();
    const idx = users.findIndex(u => u.id === user.id);
    if (idx !== -1) { users[idx].lastLogin = new Date().toISOString(); saveUsers(users); }
    res.json({ success:true, name:user.name, role:user.role, username:user.username });
  });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ success:true }));
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  const { id, username, name, role, createdAt, lastLogin } = req.user;
  res.json({ id, username, name, role, createdAt, lastLogin });
});

// ── Rutas de administración de usuarios ────────────────────────────────────────
app.get('/api/admin/users', requireAuth, requireAdmin, (_req, res) => {
  const users = loadUsers().map(({ password: _p, ...u }) => u);
  res.json(users);
});

app.post('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  const { username, name, password, role } = req.body;
  if (!username || !name || !password) return res.status(400).json({ error:'Usuario, nombre y contraseña son obligatorios.' });
  if (password.length < 8) return res.status(400).json({ error:'La contraseña debe tener al menos 8 caracteres.' });

  const users = loadUsers();
  const slug = username.trim().toLowerCase();
  if (users.find(u => u.username.toLowerCase() === slug)) return res.status(409).json({ error:'Ese nombre de usuario ya existe.' });

  const hash = await bcrypt.hash(password, 12);
  const user = { id:uuidv4(), username:slug, name:name.trim(), password:hash, role:role==='admin'?'admin':'user', active:true, createdAt:new Date().toISOString(), lastLogin:null };
  users.push(user);
  saveUsers(users);
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

  if (name)            users[idx].name   = name.trim();
  if (role)            users[idx].role   = role === 'admin' ? 'admin' : 'user';
  if (active !== undefined) users[idx].active = !!active;
  if (password) {
    if (password.length < 8) return res.status(400).json({ error:'La contraseña debe tener al menos 8 caracteres.' });
    users[idx].password = await bcrypt.hash(password, 12);
  }

  saveUsers(users);
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
  res.json({ success:true });
});

app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error:'Introduce la contraseña actual y la nueva.' });
  if (newPassword.length < 8) return res.status(400).json({ error:'La nueva contraseña debe tener al menos 8 caracteres.' });

  const users = loadUsers();
  const idx = users.findIndex(u => u.id === req.user.id);
  const ok = await bcrypt.compare(currentPassword, users[idx].password);
  if (!ok) return res.status(401).json({ error:'La contraseña actual no es correcta.' });

  users[idx].password = await bcrypt.hash(newPassword, 12);
  saveUsers(users);
  res.json({ success:true });
});

app.get('/api/health', (_req, res) => res.json({
  status:'ok', model:MODEL, version:'8.0.0', users:loadUsers().length,
  limits: { maqChunk:MAQ_CHUNK, maqSingle:MAQ_SINGLE, historyLimit:HISTORY_LIMIT }
}));

// ── Aplicar auth a todo lo demás ──────────────────────────────────────────────
app.use(requireAuth);
app.use(express.static(path.join(__dirname, 'public')));

// ── Multer ────────────────────────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_MB*1024*1024, files: MAX_TOPICS },
  fileFilter: (_req, file, cb) => /\.(docx?|pdf)$/i.test(file.originalname) ? cb(null,true) : cb(new Error(`Tipo no permitido: ${file.originalname}`))
});

// ── Helpers de Claude ─────────────────────────────────────────────────────────
const LETTERS = ['A','B','C','D','E'];
async function callClaude(messages, maxTokens=8000) {
  const r = await anthropic.messages.create({ model:MODEL, max_tokens:maxTokens, messages });
  return r.content.filter(b=>b.type==='text').map(b=>b.text).join('\n').trim();
}
function makeMessages(prompt, topic, textOverride=null) {
  // textOverride permite pasar un chunk específico en lugar de todo el texto
  if (textOverride) {
    return [{ role:'user', content:`CONTENIDO DE "${topic.name}":\n---\n${textOverride}\n---\n\n${prompt}` }];
  }
  if (topic?.type==='pdf' && topic.base64 && (!topic.text || topic.text.length < MAQ_SINGLE)) {
    return [{ role:'user', content:[{type:'document',source:{type:'base64',media_type:'application/pdf',data:topic.base64}},{type:'text',text:prompt}]}];
  }
  const textToUse = topic.text ? topic.text.substring(0, MAX_CHARS) : '';
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
function htmlToText(html) {
  return html
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
function makeDoc(children, name, footerTxt, colorT, colorL, extra={}) {
  return new Document({
    numbering:{config:[
      {reference:'bullets',levels:[{level:0,format:LevelFormat.BULLET,text:'\u2022',alignment:AlignmentType.LEFT,style:{paragraph:{indent:{left:720,hanging:360}},run:{font:'Arial',size:22}}}]},
      {reference:'numbers',levels:[{level:0,format:LevelFormat.DECIMAL,text:'%1.',alignment:AlignmentType.LEFT,style:{paragraph:{indent:{left:720,hanging:360}},run:{font:'Arial',size:22}}}]}
    ]},
    styles:{default:{document:{run:{font:'Arial',size:22}}},paragraphStyles:[
      {id:'Heading1',name:'Heading 1',basedOn:'Normal',next:'Normal',quickFormat:true,run:{size:extra.h1Size||36,bold:true,font:'Arial',color:colorT},paragraph:{spacing:{before:0,after:360},outlineLevel:0}},
      {id:'Heading2',name:'Heading 2',basedOn:'Normal',next:'Normal',quickFormat:true,run:{size:extra.h2Size||26,bold:true,font:'Arial',color:extra.h2Color||'2E75B6'},paragraph:{spacing:{before:300,after:100},outlineLevel:1}},
      {id:'Heading3',name:'Heading 3',basedOn:'Normal',next:'Normal',quickFormat:true,run:{size:extra.h3Size||24,bold:true,font:'Arial',color:extra.h3Color||'404040'},paragraph:{spacing:{before:260,after:100},outlineLevel:2}}
    ]},
    sections:[{
      properties:{page:{size:{width:11906,height:16838},margin:{top:1440,right:1440,bottom:1440,left:1440}}},
      headers:{default:new Header({children:[new Paragraph({children:[new TextRun({text:`Suite Académica · ${name}`,font:'Arial',size:18,color:extra.headerColor||'8f8d88'})],border:{bottom:mkBrd(colorL,6)},spacing:{before:0,after:100}})]})},
      footers:{default:new Footer({children:[new Paragraph({children:[new TextRun({text:`${footerTxt} · `,font:'Arial',size:16,color:extra.headerColor||'8f8d88'}),new TextRun({children:['Pág. ',PageNumber.CURRENT,' / ',PageNumber.TOTAL_PAGES],font:'Arial',size:16,color:extra.headerColor||'8f8d88'})],alignment:AlignmentType.RIGHT,border:{top:mkBrd(colorL,4)},spacing:{before:100,after:0}})]})},
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

// ── Maquetación: Word con colores personalizables (plantilla) ─────────────────
function buildMaquetadoDoc(data, imageStore, colors, quiz) {
  // colors es un objeto de la plantilla aplicada
  const C = colors || DEFAULT_TEMPLATES[0].colors;
  const CH1 = C.h1, CH2 = C.h2, CH3 = C.h3;
  const CL1 = C.lineH1, CL2 = C.lineH2;
  const CTT = C.title || CH2;
  const CBD = C.brd || 'D0CEC8';
  const HDR = C.header || '8f8d88';

  const children = [
    new Paragraph({
      children:[new TextRun({text:data.title||'Documento maquetado',font:'Arial',size:40,bold:true,color:CTT})],
      spacing:{before:0,after:480},
      alignment:AlignmentType.CENTER,
      border:{bottom:{style:BorderStyle.SINGLE,size:8,color:CL1}}
    })
  ];

  for (const block of data.blocks||[]) {
    const {t, n, text, items, idx} = block;
    if (t === 'h1') {
      children.push(new Paragraph({
        heading:HeadingLevel.HEADING_1,
        children:[new TextRun({text:(n?n+' ':'')+text,font:'Arial',size:30,bold:true,color:CH1})],
        spacing:{before:440,after:180},
        border:{bottom:{style:BorderStyle.SINGLE,size:6,color:CL1}}
      }));
    } else if (t === 'h2') {
      children.push(new Paragraph({
        heading:HeadingLevel.HEADING_2,
        children:[new TextRun({text:(n?n+' ':'')+text,font:'Arial',size:26,bold:true,color:CH2})],
        spacing:{before:320,after:120},
        border:{bottom:{style:BorderStyle.SINGLE,size:4,color:CL2}}
      }));
    } else if (t === 'h3') {
      children.push(new Paragraph({
        heading:HeadingLevel.HEADING_3,
        children:[new TextRun({text:(n?n+' ':'')+text,font:'Arial',size:24,bold:true,color:CH3})],
        spacing:{before:260,after:100}
      }));
    } else if (t === 'p' && text) {
      children.push(new Paragraph({
        children:[new TextRun({text:ensurePeriod(text.trim()),font:'Arial',size:22})],
        spacing:{before:0,after:140},
        alignment:AlignmentType.JUSTIFIED
      }));
    } else if ((t === 'ul' || t === 'ol') && Array.isArray(items)) {
      for (const item of items) {
        children.push(new Paragraph({
          numbering:{reference:t==='ul'?'bullets':'numbers',level:0},
          children:[new TextRun({text:ensurePeriod(item.trim()),font:'Arial',size:22})],
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
          spacing:{before:200,after:200}
        }));
      } catch(_){
        children.push(new Paragraph({
          children:[new TextRun({text:`[Imagen ${idx+1}]`,font:'Arial',size:20,color:'888780'})],
          alignment:AlignmentType.CENTER,
          spacing:{before:120,after:120}
        }));
      }
    }
  }

  // ── Sección de autoevaluación (opcional) ────────────────────────────────────
  if (quiz && Array.isArray(quiz.questions) && quiz.questions.length > 0) {
    const qLetters = ['A','B','C','D','E'];
    // Cabecera de la sección
    children.push(new Paragraph({
      heading:HeadingLevel.HEADING_1,
      children:[new TextRun({text:'AUTOEVALUACIÓN', font:'Arial', size:30, bold:true, color:CH1})],
      spacing:{before:600, after:200},
      border:{bottom:{style:BorderStyle.SINGLE,size:6,color:CL1}},
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

    // Preguntas
    quiz.questions.forEach((q, i) => {
      // Enunciado
      children.push(new Paragraph({
        children:[
          new TextRun({text:`${i+1}. `, font:'Arial', size:22, bold:true}),
          new TextRun({text:q.q || '', font:'Arial', size:22})
        ],
        spacing:{before:200, after:100},
        alignment:AlignmentType.JUSTIFIED
      }));
      // Opciones
      if (quiz.type === 'vf') {
        children.push(new Paragraph({
          children:[
            new TextRun({text:'☐ Verdadero            ☐ Falso', font:'Arial', size:22})
          ],
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
      children:[new TextRun({text:'SOLUCIONES', font:'Arial', size:30, bold:true, color:CH1})],
      spacing:{before:600, after:200},
      border:{bottom:{style:BorderStyle.SINGLE,size:6,color:CL1}},
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

  return makeDoc(children, data.title || 'Documento',
    'Maquetado SCORMXPRESS · Suite Académica v8.0',
    CBD, CBD,
    { h1Size:30, h1Color:CH1, h2Size:26, h2Color:CH2, h3Size:24, h3Color:CH3, headerColor:HDR }
  );
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
  const { hasImages = false, chunkMode = false, chunkInfo = null } = options;
  const imgNote = hasImages
    ? `\nEl texto contiene marcadores __IMG_N__. Inclúyelos como {"t":"img","idx":N} en la posición correcta del flujo.`
    : '';
  const chunkNote = chunkMode
    ? `\nESTA ES UNA SECCIÓN de un documento más extenso (${chunkInfo}). Estructura solo lo contenido en esta sección. No inventes un "título" general — devuelve title vacío "" si es una sección intermedia, o si reconoces el título del documento completo, úsalo solo en la primera sección.`
    : '';
  return `Eres experto en maquetación académica SCORMXPRESS. Reestructura este contenido con jerarquía clara para virtualización.

DIRECTRICES OBLIGATORIAS:
1. Jerarquía máxima de 3 niveles: h1 (sección principal), h2 (subsección), h3 (detalle).
2. Numeración manual con punto al final en cada título: "1.", "1.1.", "1.1.1.", "2.", etc.
3. TODO párrafo DEBE terminar con punto final. Cada elemento de lista también DEBE terminar con punto. Esto es CRÍTICO porque el texto se locutará con IA y sin punto la lectura no pausa.
4. Listas con viñetas (ul) para enumeraciones no ordenadas y listas numeradas (ol) para pasos o secuencias.
5. Incluye TODO el contenido original reorganizado — no resumas ni elimines información.
6. Los párrafos deben ser unidades de texto completas y coherentes. No cortes frases.
7. No uses negritas dentro del texto de los párrafos; usa h2 o h3 para resaltar términos clave.${imgNote}${chunkNote}

REGLAS CRÍTICAS PARA NO CONFUNDIR ELEMENTOS CON TÍTULOS (esto es donde más fallan los modelos):
- Un h1/h2/h3 debe ir SIEMPRE seguido de contenido sustancial (al menos un párrafo de varias frases o varios elementos de lista). NO marques como título un texto si tras él no hay desarrollo, o sólo hay otro título inmediato.
- ELEMENTOS DE LISTA: viñetas, ítems numerados (a), b), c) — 1º, 2º, 3º — i, ii, iii — •, –, *) NUNCA se marcan como h1/h2/h3. Van como items dentro de "ul" u "ol".
- EPÍGRAFES CORTOS / ETIQUETAS DE CAMPO: textos breves que actúan como rótulo seguidos del valor en la misma frase, tipo "OBJETIVO:", "REQUISITOS:", "DEFINICIÓN:", "PLAZO:", "EJEMPLO:", "ART. 5:" → NO son títulos. Inclúyelos dentro del párrafo, integrando el valor: "El objetivo es…", "Los requisitos son los siguientes:".
- ARTÍCULOS / APARTADOS NUMERADOS dentro de un texto normativo: "Artículo 5.-", "Apartado a)", "Punto 3.1.", "Disposición Adicional Primera" → si son cabecera de un articulado completo con varios párrafos debajo, sí pueden ser h2/h3; si son sólo numeración de un punto dentro de una enumeración, van como item de lista o dentro del párrafo.
- FRASES EN MAYÚSCULAS sueltas o de énfasis: si no introducen un bloque sustancial, son énfasis dentro del texto, no títulos. Inclúyelas en mayúsculas al inicio del párrafo correspondiente.
- PIES DE IMAGEN, citas, notas al pie: van como párrafo, NUNCA como título.
- En caso de duda entre marcar un texto como título o como párrafo: elige PÁRRAFO. Es mucho peor crear títulos falsos que perder algún subtítulo.

REGLA DE COHERENCIA JERÁRQUICA:
- No saltes niveles (no pongas h3 si el padre lógico no es h2).
- No abras un h1 nuevo dentro de la misma sección temática; usa h2.
- Si solo hay UNA subsección bajo un h1, no hace falta crear un h2.

Devuelve ÚNICAMENTE JSON válido (sin texto antes ni después, sin \`\`\`json) con esta estructura:
{
  "title": "Título del documento (vacío si es sección intermedia)",
  "blocks": [
    {"t":"h1","n":"1.","text":"Título de sección"},
    {"t":"h2","n":"1.1.","text":"Subtítulo"},
    {"t":"p","text":"Párrafo completo terminado en punto."},
    {"t":"ul","items":["Primer punto terminado en punto.","Segundo punto terminado en punto."]},
    {"t":"ol","items":["Primer paso.","Segundo paso."]},
    {"t":"img","idx":0}
  ]
}`;
}

function parseMaqJson(raw) {
  let s = raw.replace(/```json|```/g,'').trim();
  const si = s.indexOf('{'), ei = s.lastIndexOf('}') + 1;
  if (si >= 0 && ei > si) s = s.substring(si, ei);
  const data = JSON.parse(s);
  if (!data.blocks || !Array.isArray(data.blocks)) throw new Error('JSON inválido: falta blocks[]');
  return data;
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
app.post('/api/upload', upload.array('files', MAX_TOPICS), async (req, res) => {
  if (!req.files?.length) return res.status(400).json({ error:'No se recibieron archivos.' });
  try {
    const topics = await Promise.all(req.files.map(async file => {
      const id = uuidv4();
      let topic;
      if (/\.pdf$/i.test(file.originalname)) {
        // PDF: guardar base64 + extraer texto con pdf-parse
        const base64 = file.buffer.toString('base64');
        let text = '', pages = 0;
        try {
          const parsed = await pdfParse(file.buffer);
          text = (parsed.text || '').trim();
          pages = parsed.numpages || 0;
        } catch(e) {
          console.warn('pdf-parse error:', e.message);
        }
        const words = text ? text.split(/\s+/).filter(Boolean).length : 0;
        topic = {
          id, name:file.originalname, type:'pdf',
          base64, text, words, pages,
          sizeKB: Math.round(file.size/1024),
          images: []
        };
      } else {
        const images = [];
        let textWithMarkers = '';
        try {
          const hr = await mammoth.convertToHtml(
            { buffer:file.buffer },
            { convertImage: mammoth.images.imgElement(async (image) => {
                const buf = await image.read();
                const idx = images.length;
                images.push({ data:buf, type:image.contentType });
                return { src:`__IMG_${idx}__` };
            }) }
          );
          textWithMarkers = htmlToText(hr.value);
        } catch(_) {
          const r = await mammoth.extractRawText({ buffer:file.buffer });
          textWithMarkers = r.value.trim();
        }
        const words = textWithMarkers.replace(/__IMG_\d+__/g,'').split(/\s+/).filter(Boolean).length;
        if (words < 10) throw new Error(`"${file.originalname}" tiene muy poco texto.`);
        topic = { id, name:file.originalname, type:'docx', text:textWithMarkers, images, words };
      }
      topicCache.set(id, { ...topic, ts:Date.now() });
      return {
        id, name:topic.name, type:topic.type,
        words: topic.words || null,
        sizeKB: topic.sizeKB || null,
        imageCount: topic.images?.length || 0,
        pages: topic.pages || null,
        largeDoc: (topic.text?.length || 0) > MAQ_SINGLE
      };
    }));
    res.json({ success:true, topics });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/generate (SSE) — banco de preguntas ─────────────────────────────
app.post('/api/generate', async (req, res) => {
  res.setHeader('Content-Type','text/event-stream');
  res.setHeader('Cache-Control','no-cache');
  res.setHeader('Connection','keep-alive');
  res.setHeader('X-Accel-Buffering','no');
  res.flushHeaders();

  const send = d => { try { res.write(`data: ${JSON.stringify(d)}\n\n`); } catch(_){} };
  const { topicIds, config } = req.body;
  const topics = topicIds.map(id => topicCache.get(id)).filter(Boolean);
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
app.post('/api/summarize', async (req, res) => {
  res.setHeader('Content-Type','text/event-stream');
  res.setHeader('Cache-Control','no-cache');
  res.setHeader('Connection','keep-alive');
  res.setHeader('X-Accel-Buffering','no');
  res.flushHeaders();

  const send = d => { try { res.write(`data: ${JSON.stringify(d)}\n\n`); } catch(_){} };
  const { topicIds, pages } = req.body;
  const topics = topicIds.map(id => topicCache.get(id)).filter(Boolean);
  if (!topics.length) { send({type:'error',message:'Temas no encontrados.'}); return res.end(); }
  const tw = pages * 480;
  send({ type:'start', total:topics.length });

  try {
    for (let i = 0; i < topics.length; i++) {
      const topic = topics[i];
      send({ type:'progress', current:i+1, total:topics.length, name:topic.name });
      const prompt = `Genera un resumen académico exhaustivo con aproximadamente ${tw} palabras (${pages} páginas Word). Organízalo con SUBTÍTULOS EN MAYÚSCULAS para cada bloque temático. Cubre TODOS los conceptos. Español académico correcto. Todos los párrafos deben terminar con punto. Alcanza los ${tw} palabras.`;
      const text = await callClaude(
        makeMessages(prompt, topic),
        Math.min(16000, Math.max(4000, tw*2))
      );
      send({ type:'result', name:topic.name, text, wordCount: text.split(/\s+/).filter(Boolean).length });
    }
    send({ type:'complete' });
  } catch(err) {
    send({ type:'error', message: err.message });
  } finally {
    res.end();
  }
});

app.post('/api/summary-docx', async (req,res) => {
  const { name, text } = req.body;
  if (!text) return res.status(400).json({ error:'Sin contenido.' });
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
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/map — mapa conceptual ───────────────────────────────────────────
app.post('/api/map', async (req, res) => {
  const { topicId, depth } = req.body;
  const topic = topicCache.get(topicId);
  if (!topic) return res.status(404).json({ error:'Tema no encontrado.' });
  const dm = {
    simple:    '4-5 ramas · 2-3 subnodos',
    completo:  '6-7 ramas · 3-4 subnodos',
    detallado: '7-8 ramas · 4-5 subnodos'
  };
  const prompt = `Analiza el documento y genera un mapa conceptual. Devuelve ÚNICAMENTE JSON válido:
{"title":"Título (máx 4 palabras)","branches":[{"label":"Concepto (2-4 palabras)","nodes":["Subconcepto"]}]}
Estructura: ${dm[depth] || dm.completo}`;
  try {
    let raw = await callClaude(makeMessages(prompt, topic), 4000);
    raw = raw.replace(/```json|```/g,'').trim();
    const s = raw.indexOf('{'), e = raw.lastIndexOf('}') + 1;
    if (s >= 0) raw = raw.substring(s, e);
    const data = JSON.parse(raw);
    if (!data.title || !data.branches?.length) throw new Error('JSON inválido');
    res.json({ success:true, data });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/maqueta (SSE) — maquetación con chunking para docs grandes ─────
app.post('/api/maqueta', async (req, res) => {
  res.setHeader('Content-Type','text/event-stream');
  res.setHeader('Cache-Control','no-cache');
  res.setHeader('Connection','keep-alive');
  res.setHeader('X-Accel-Buffering','no');
  res.flushHeaders();

  const send = d => { try { res.write(`data: ${JSON.stringify(d)}\n\n`); } catch(_){} };
  const { topicId } = req.body;
  const topic = topicCache.get(topicId);
  if (!topic) { send({type:'error',message:'Tema no encontrado.'}); return res.end(); }

  const hasImages = topic.images?.length > 0;
  const textLength = topic.text?.length || 0;
  const useChunking = textLength > MAQ_SINGLE;

  try {
    if (!useChunking) {
      // Documento pequeño o PDF nativo: llamada única
      send({ type:'start', mode:'single', totalChunks:1 });
      send({ type:'progress', chunk:1, total:1, pct:20, label:'Analizando estructura del documento...' });
      const prompt = buildMaquetaPrompt({ hasImages, chunkMode:false });
      const raw = await callClaude(makeMessages(prompt, topic), 16000);
      send({ type:'progress', chunk:1, total:1, pct:85, label:'Procesando respuesta...' });
      const data = parseMaqJson(raw);
      const stats = (data.blocks || []).reduce((s,b) => { s[b.t] = (s[b.t]||0) + 1; return s; }, {});
      send({
        type:'complete',
        data,
        stats,
        truncated: topic.type === 'docx' && (topic.text?.length || 0) > MAX_CHARS && !useChunking,
        hasImages,
        mode:'single'
      });
      return res.end();
    }

    // Documento grande: chunking sobre texto extraído
    if (!topic.text) {
      send({ type:'error', message:'No se pudo extraer texto del documento para procesarlo en secciones.' });
      return res.end();
    }

    const chunks = splitIntoChunks(topic.text, MAQ_CHUNK);
    send({ type:'start', mode:'chunked', totalChunks:chunks.length, textLength, pages:topic.pages||null });

    const allBlocks = [];
    let finalTitle = '';

    for (let i = 0; i < chunks.length; i++) {
      send({
        type:'progress',
        chunk: i+1,
        total: chunks.length,
        pct: Math.round((i / chunks.length) * 92) + 2,
        label: `Maquetando sección ${i+1} de ${chunks.length}...`
      });
      const chunkPrompt = buildMaquetaPrompt({
        hasImages: i === 0 && hasImages, // las imágenes de docx suelen estar repartidas pero los marcadores vienen en el chunk
        chunkMode: true,
        chunkInfo: `sección ${i+1} de ${chunks.length}`
      });
      const msg = [{ role:'user', content:`CONTENIDO DE "${topic.name}" (sección ${i+1}/${chunks.length}):\n---\n${chunks[i]}\n---\n\n${chunkPrompt}` }];
      try {
        const raw = await callClaude(msg, 16000);
        const data = parseMaqJson(raw);
        if (i === 0 && data.title) finalTitle = data.title;
        if (Array.isArray(data.blocks)) allBlocks.push(...data.blocks);
      } catch (e) {
        // Si falla un chunk, continuamos con los siguientes pero avisamos
        send({ type:'chunk_error', chunk:i+1, message:e.message });
      }
    }

    const finalData = {
      title: finalTitle || topic.name.replace(/\.[^.]+$/,''),
      blocks: allBlocks
    };
    const stats = allBlocks.reduce((s,b) => { s[b.t] = (s[b.t]||0) + 1; return s; }, {});
    send({
      type:'complete',
      data: finalData,
      stats,
      truncated: false,
      hasImages,
      mode:'chunked',
      processedChunks: chunks.length
    });
    res.end();
  } catch(err) {
    send({ type:'error', message: err.message });
    res.end();
  }
});

// ── POST /api/maqueta-quiz — genera autoevaluación integrada en JSON ─────────
app.post('/api/maqueta-quiz', async (req, res) => {
  const { topicId, type, num, diff } = req.body;
  const topic = topicCache.get(topicId);
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
    res.status(500).json({ error:'No se pudo generar la autoevaluación: ' + err.message });
  }
});

// ── POST /api/maqueta-docx — genera Word con plantilla de color ──────────────
app.post('/api/maqueta-docx', async (req, res) => {
  const { data, topicId, templateId, colors, quiz } = req.body;
  if (!data || !Array.isArray(data.blocks)) return res.status(400).json({ error:'Sin datos.' });
  try {
    const imageStore = topicId ? topicCache.get(topicId)?.images : null;

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
        questions: quiz.questions
      };
    }

    const doc = buildMaquetadoDoc(data, imageStore, finalColors, cleanQuiz);
    const buf = await Packer.toBuffer(doc);
    const safe = (data.title || 'documento')
      .replace(/[^\w\-áéíóúüñÁÉÍÓÚÜÑ ]/g,'_')
      .substring(0,60).trim();
    res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition',`attachment; filename="${safe}_maquetado.docx"`);
    res.send(buf);
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/zip', async (req, res) => {
  const { files } = req.body;
  if (!files?.length) return res.status(400).json({ error:'Sin archivos' });
  try {
    const zip = new JSZip();
    files.forEach(f => zip.file(f.name, f.content));
    const buf = await zip.generateAsync({ type:'nodebuffer', compression:'DEFLATE' });
    res.setHeader('Content-Type','application/zip');
    res.setHeader('Content-Disposition','attachment; filename="exportacion.zip"');
    res.send(buf);
  } catch(err) {
    res.status(500).json({ error: err.message });
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
async function callMoodle(baseUrl, token, wsfunction, params={}) {
  const endpoint = `${baseUrl.replace(/\/+$/,'')}/webservice/rest/server.php`;
  const body = new URLSearchParams({ wstoken:token, wsfunction, moodlewsrestformat:'json', ...params });
  const response = await fetch(endpoint, {
    method: 'POST',
    body: body.toString(),
    headers: { 'Content-Type':'application/x-www-form-urlencoded' },
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  if (data?.exception) throw new Error(data.message || data.debuginfo || data.exception);
  if (data?.error) throw new Error(data.error);
  return data;
}

app.post('/api/moodle/test', async (req, res) => {
  const { url, token } = req.body;
  if (!url || !token) return res.status(400).json({ error:'URL y token obligatorios.' });
  try {
    const info = await callMoodle(url, token, 'core_webservice_get_site_info');
    res.json({
      success:true,
      sitename:info.sitename, release:info.release, version:info.version,
      userid:info.userid, username:info.username, fullname:info.fullname
    });
  } catch(err) {
    res.status(400).json({ error:'No se pudo conectar: ' + err.message });
  }
});

app.post('/api/moodle/courses', async (req, res) => {
  const { url, token, userid } = req.body;
  if (!url || !token) return res.status(400).json({ error:'URL y token obligatorios.' });
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
    res.status(400).json({ error:'Error obteniendo cursos: ' + err.message });
  }
});

app.post('/api/moodle/import', async (req, res) => {
  const { url, token, courseid, giftContent, filename } = req.body;
  if (!url || !token || !courseid || !giftContent) return res.status(400).json({ error:'Faltan parámetros.' });
  try {
    const fname = (filename || 'banco_preguntas').replace(/[^a-zA-Z0-9_\-]/g,'_') + '.gift';
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
      return res.json({
        success:true, method:'manual',
        message:`Archivo subido a Moodle. Impórtalo manualmente: Banco de preguntas → Importar → Formato GIFT → seleccionar "${fname}" desde borradores.`,
        importError: importErr.message
      });
    }
  } catch(err) {
    res.status(400).json({ error:'Error: ' + err.message });
  }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── Arranque ──────────────────────────────────────────────────────────────────
initUsers().then(() => {
  app.listen(PORT, HOST, () => {
    console.log(`\n✅  Suite Académica Moodle · v8.0`);
    console.log(`   URL    : http://${HOST==='0.0.0.0'?'localhost':HOST}:${PORT}`);
    console.log(`   Modelo : ${MODEL}`);
    console.log(`   Usuarios: ${loadUsers().length} registrados`);
    console.log(`   Límites: chunk=${MAQ_CHUNK} · single=${MAQ_SINGLE} · historial=${HISTORY_LIMIT}\n`);
  });
});
