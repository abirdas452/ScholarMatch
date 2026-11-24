require('dotenv').config();
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { parse } = require('csv-parse/sync');
const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');

const app = express();
const PORT = Number(process.env.PORT || 3000);
if (process.env.NODE_ENV === 'production' && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)) {
  throw new Error('Production requires SESSION_SECRET with at least 32 characters.');
}
const DB_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DB_DIR, { recursive: true });
const db = new sqlite3.Database(path.join(DB_DIR, 'scholarmatch.sqlite'));
const run = (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, function (err) { err ? reject(err) : resolve(this); }));
const get = (sql, params = []) => new Promise((resolve, reject) => db.get(sql, params, (err, row) => err ? reject(err) : resolve(row)));
const all = (sql, params = []) => new Promise((resolve, reject) => db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows)));

async function init() {
  await run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'student' CHECK(role IN ('student','admin')), created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
  await run(`CREATE TABLE IF NOT EXISTS scholarships (id INTEGER PRIMARY KEY AUTOINCREMENT, source_id TEXT, name TEXT NOT NULL, provider TEXT NOT NULL, min_cgpa REAL NOT NULL DEFAULT 0, department TEXT NOT NULL DEFAULT 'All', need_based TEXT NOT NULL DEFAULT 'no', gender TEXT NOT NULL DEFAULT 'All', amount_bdt INTEGER NOT NULL DEFAULT 0, deadline TEXT, description TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
  const count = await get('SELECT COUNT(*) AS n FROM scholarships');
  if (!count.n) {
    const csv = fs.readFileSync(path.join(__dirname, 'data', 'scholarships.csv'), 'utf8');
    const rows = parse(csv, { columns: true, skip_empty_lines: true, bom: true });
    for (const s of rows) await run('INSERT INTO scholarships (source_id,name,provider,min_cgpa,department,need_based,gender,amount_bdt,deadline,description) VALUES (?,?,?,?,?,?,?,?,?,?)', [s.id, s.name, s.provider, Number(s.min_cgpa)||0, s.department||'All', (s.need_based||'no').toLowerCase(), s.gender||'All', Number(s.amount_bdt)||0, s.deadline||null, s.description||'']);
  }
  if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
    const email = process.env.ADMIN_EMAIL.trim().toLowerCase();
    const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 12);
    await run(`INSERT INTO users(name,email,password_hash,role) VALUES(?,?,?,'admin') ON CONFLICT(email) DO UPDATE SET name=excluded.name,password_hash=excluded.password_hash,role='admin'`, [process.env.ADMIN_NAME || 'Admin', email, hash]);
  }
}

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'], fontSrc: ["'self'", 'https://fonts.gstatic.com'], scriptSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"] } } }));
app.use(express.json({ limit: '40kb' }));
app.use(session({
  store: new SQLiteStore({ db: 'sessions.sqlite', dir: DB_DIR }),
  secret: process.env.SESSION_SECRET || 'development-only-change-this-session-secret-please',
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 1000 * 60 * 60 * 8 }
}));
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false }));
const requireAuth = (req, res, next) => req.session.user ? next() : res.status(401).json({ error: 'Please sign in to continue.' });
const requireAdmin = (req, res, next) => req.session.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Admin permission required.' });
const publicUser = u => ({ id: u.id, name: u.name, email: u.email, role: u.role });

app.post('/api/auth/signup', async (req, res) => {
  try {
    const name = String(req.body.name || '').trim().slice(0, 70);
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 10) return res.status(400).json({ error: 'Enter a valid name/email and password with at least 10 characters.' });
    const hash = await bcrypt.hash(password, 12);
    const result = await run("INSERT INTO users(name,email,password_hash,role) VALUES(?,?,?,'student')", [name, email, hash]);
    req.session.user = { id: result.lastID, name, email, role: 'student' };
    res.status(201).json({ user: req.session.user });
  } catch (e) { res.status(e.message.includes('UNIQUE') ? 409 : 500).json({ error: e.message.includes('UNIQUE') ? 'This email is already registered.' : 'Could not create account.' }); }
});
app.post('/api/auth/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const user = await get('SELECT * FROM users WHERE email=?', [email]);
  if (!user || !(await bcrypt.compare(String(req.body.password || ''), user.password_hash))) return res.status(401).json({ error: 'Email or password is incorrect.' });
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: 'Could not start a secure session.' });
    req.session.user = publicUser(user);
    res.json({ user: req.session.user });
  });
});
app.post('/api/auth/logout', (req, res) => req.session.destroy(() => { res.clearCookie('connect.sid'); res.json({ ok: true }); }));
app.get('/api/auth/me', (req, res) => res.json({ user: req.session.user || null }));

app.get('/api/scholarships', async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 100);
  const rows = q ? await all('SELECT * FROM scholarships WHERE name LIKE ? OR provider LIKE ? OR department LIKE ? ORDER BY deadline ASC', [`%${q}%`,`%${q}%`,`%${q}%`]) : await all('SELECT * FROM scholarships ORDER BY deadline ASC');
  res.json({ scholarships: rows });
});
app.get('/api/admin/overview', requireAuth, requireAdmin, async (req, res) => {
  const [total, users, need, providers, recent] = await Promise.all([
    get('SELECT COUNT(*) n FROM scholarships'), get('SELECT COUNT(*) n FROM users'), get("SELECT COUNT(*) n FROM scholarships WHERE lower(need_based)='yes'"), get('SELECT COUNT(DISTINCT provider) n FROM scholarships'), all('SELECT id,name,provider,amount_bdt,deadline FROM scholarships ORDER BY id DESC LIMIT 6')
  ]);
  res.json({ total: total.n, users: users.n, needBased: need.n, providers: providers.n, recent });
});
app.post('/api/admin/scholarships', requireAuth, requireAdmin, async (req, res) => {
  const s = req.body || {};
  if (!String(s.name||'').trim() || !String(s.provider||'').trim()) return res.status(400).json({ error: 'Scholarship name and provider are required.' });
  const r = await run('INSERT INTO scholarships(name,provider,min_cgpa,department,need_based,gender,amount_bdt,deadline,description) VALUES(?,?,?,?,?,?,?,?,?)', [String(s.name).trim(),String(s.provider).trim(),Number(s.min_cgpa)||0,String(s.department||'All'),String(s.need_based||'no'),String(s.gender||'All'),Number(s.amount_bdt)||0,s.deadline||null,String(s.description||'')]);
  res.status(201).json({ id: r.lastID });
});
app.put('/api/admin/scholarships/:id', requireAuth, requireAdmin, async (req, res) => {
  const s = req.body || {};
  await run('UPDATE scholarships SET name=?,provider=?,min_cgpa=?,department=?,need_based=?,gender=?,amount_bdt=?,deadline=?,description=? WHERE id=?', [String(s.name||'').trim(),String(s.provider||'').trim(),Number(s.min_cgpa)||0,String(s.department||'All'),String(s.need_based||'no'),String(s.gender||'All'),Number(s.amount_bdt)||0,s.deadline||null,String(s.description||''),Number(req.params.id)]);
  res.json({ ok: true });
});
app.delete('/api/admin/scholarships/:id', requireAuth, requireAdmin, async (req, res) => { await run('DELETE FROM scholarships WHERE id=?', [Number(req.params.id)]); res.json({ ok: true }); });

app.post('/api/ai/recommend', requireAuth, async (req, res) => {
  const p = req.body || {};
  const cgpa = Number(p.cgpa);
  if (!Number.isFinite(cgpa) || cgpa < 0 || cgpa > 4) return res.status(400).json({ error: 'CGPA must be between 0 and 4.' });
  const dept = String(p.department||'').slice(0,80);
  const gender = String(p.gender||'Prefer not to say');
  const need = Boolean(p.needBased);
  const allScholarships = await all('SELECT id,name,provider,min_cgpa,department,need_based,gender,amount_bdt,deadline,description FROM scholarships');
  const matched = allScholarships.filter(s => (s.department.toLowerCase()==='all'||s.department.toLowerCase()===dept.toLowerCase()) && cgpa >= s.min_cgpa && (s.gender.toLowerCase()==='all'||gender==='Prefer not to say'||s.gender.toLowerCase()===gender.toLowerCase()) && (s.need_based.toLowerCase()!=='yes'||need));
  const shortlist = matched.slice(0, 18);
  if (process.env.OPENAI_API_KEY) {
    try {
      const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const completion = await client.chat.completions.create({ model: process.env.OPENAI_MODEL || 'gpt-4o-mini', temperature: 0.35, max_tokens: 700,
        messages: [
          { role: 'system', content: 'You are ScholarMatch, a careful scholarship guidance assistant for students. Use only the scholarship data supplied. Never invent eligibility, awards, deadlines, links or guarantees. Explain that final eligibility must be confirmed with the provider. Return concise, friendly advice with headings and bullet points.' },
          { role: 'user', content: JSON.stringify({ student: { department: dept, cgpa, gender, needBased: need }, matchingScholarships: shortlist }) }
        ] });
      return res.json({ mode: 'ai', answer: completion.choices[0]?.message?.content || 'No AI response returned.', matches: matched.length });
    } catch (e) { console.error('AI provider error:', e.message); return res.status(502).json({ error: 'AI service is temporarily unavailable. Please try again later.' }); }
  }
  const top = shortlist.slice(0,5);
  const answer = top.length ? `I found ${matched.length} scholarship(s) matching your profile.\n\nTop options:\n${top.map((s,i)=>`${i+1}. ${s.name} — ${s.provider}\n   Minimum CGPA: ${s.min_cgpa} | Award: ৳${Number(s.amount_bdt).toLocaleString('en-US')} | Deadline: ${s.deadline || 'Not listed'}\n   Why it matches: ${s.department.toLowerCase()==='all'?'Open to all departments':`Department: ${s.department}`} and your CGPA meets the minimum${s.need_based==='yes'?' (need-based support selected)':''}.`).join('\n\n')}\n\nPlease verify the latest requirements and deadline directly with each provider. Add an AI API key to enable generated, conversational guidance.` : 'No exact match was found in the current dataset. Try checking your department spelling, CGPA, or financial-support preference. You can also contact scholarship providers to ask about exceptions.';
  res.json({ mode: 'fallback', answer, matches: matched.length });
});

app.get('/api/health', (req,res) => res.json({ status: 'ok', aiConfigured: Boolean(process.env.OPENAI_API_KEY) }));
app.use(express.static(path.join(__dirname, 'public')));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Something went wrong.' }); });
init().then(() => app.listen(PORT, () => console.log(`ScholarMatch running at http://localhost:${PORT}`))).catch(err => { console.error('Startup failed:', err); process.exit(1); });
