const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { db, saveDb } = require('./db');
const { JWT_SECRET, authenticate } = require('./auth_middleware');

// ── Helpers ────────────────────────────────────────────────────────────────────
async function pushNotification(userId, type, title, body) {
  if (!db.notifications) db.notifications = [];
  await db.notifications.push({ id:uuidv4(), userId, type, title, body, read:false, createdAt:new Date().toISOString() });
}
async function notifyAdmins(type, title, body) {
  if (!db.notifications) db.notifications = [];
  db.users.filter(u => u.role==='admin').forEach(a => pushNotification(a.id, type, title, body));
}

// Generate unique member number: PSK-COUNTY-XXXXX
async function genMemberNumber(county) {
  const prefix = (county||'NBR').slice(0,3).toUpperCase();
  const seq = String(db.users.filter(u=>u.memberNumber).length + 1001).padStart(5,'0');
  return `PSK-${prefix}-${seq}`;
}

// ── Login ──────────────────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { phone, password } = req.body;
    if (!phone || !password) return res.status(400).json({ error:'Phone and password required' });
    const user = db.users.find(u =>
      u.phone === phone || (u.email && u.email === phone) || (u.nokNumber && u.nokNumber === phone)
    );
    if (!user) return res.status(401).json({ error:'Invalid credentials' });
    if (user.suspended) return res.status(403).json({ error:'Account suspended. Contact support@pikishield.co.ke.' });
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error:'Invalid credentials' });
    const token = jwt.sign({ userId:user.id, role:user.role }, JWT_SECRET, { expiresIn:'7d' });
    const { password:_, ...safe } = user;
    const safeUser = {...safe, profile:(safe.profile&&Object.keys(safe.profile).length>0)?safe.profile:null};
    res.json({ token, user:safeUser, mustChangePassword: !!user.mustChangePassword });
  } catch { res.status(500).json({ error:'Login failed' }); }
});

// ── Register Rider ─────────────────────────────────────────────────────────────
router.post('/register', async (req, res) => {
  try {
    const { fullName, phone, email, password, nationalId, county, licenseNumber,
            bikeReg, bikeType, agentId, tempUploadId,
            isOwner, ownerName, ownerPhone } = req.body;
    if (!fullName || !phone || !password || !nationalId)
      return res.status(400).json({ error:'Required fields missing' });
    if (db.users.find(u => u.phone === phone))
      return res.status(409).json({ error:'Phone number already registered' });

    const memberNumber = genMemberNumber(county);
    const hashed = await bcrypt.hash(password, 10);
    const newUser = {
      id: uuidv4(), phone, email, fullName, nationalId, memberNumber,
      password: hashed, role: 'rider', verified: false,
      kycStatus: 'pending', riskTier: 'green', riskScore: 75,
      shieldTokens: 22,            // registration bonus — 22+helmet(3)+quiz(5)=30 → first discount
      agentId: agentId || null,
      suspended: false,
      createdAt: new Date().toISOString(),
      profile: {
        county, licenseNumber, bikeReg, bikeType,
        isOwner: isOwner !== false, ownerName: ownerName || null, ownerPhone: ownerPhone || null,
        helmetCompliance: false, safeRideStreak: 0, totalRides: 0,
      }
    };
    await db.users.push(newUser);

    // Link pre-uploaded KYC docs
    if (tempUploadId) {
      db.documents.filter(d => d.tempUploadId === tempUploadId && d.userId === null)
        .forEach(d => { d.userId = newUser.id; });
    }

    notifyAdmins('new_user','👤 New Rider Registered',`${fullName} (${phone}) · ${memberNumber} · KYC pending`);
    if (agentId) {
      pushNotification(agentId,'new_user','👤 Rider Onboarded via You',`${fullName} registered using your link.`);
      const agent = db.users.find(u => u.id === agentId);
      if (agent) agent.totalOnboarded = (agent.totalOnboarded||0) + 1;
    }

    const token = jwt.sign({ userId:newUser.id, role:newUser.role }, JWT_SECRET, { expiresIn:'7d' });
    const { password:_, ...safe } = newUser;
    res.status(201).json({ token, user:safe, message:'Registration successful! KYC verification pending.' });
  } catch(e) { res.status(500).json({ error:'Registration failed: '+e.message }); }
});

// ── Register Funeral Member (agent only) ──────────────────────────────────────
router.post('/register-member', authenticate, async (req, res) => {
  try {
    if (!['agent','admin'].includes(req.user.role))
      return res.status(403).json({ error:'Agent/admin only' });
    const { fullName, phone, nationalId, county, relationship, enrollingAgentId } = req.body;
    if (!fullName || !phone || !nationalId)
      return res.status(400).json({ error:'Required fields missing' });
    if (db.users.find(u => u.phone === phone))
      return res.status(409).json({ error:'Phone already registered' });

    const memberNumber = genMemberNumber(county);
    const tempPassword = `Piki${Math.floor(1000+Math.random()*9000)}!`;
    const hashed = await bcrypt.hash(tempPassword, 10);
    const member = {
      id: uuidv4(), phone, fullName, nationalId, memberNumber,
      password: hashed, role: 'member', county,
      relationship: relationship || 'beneficiary',
      enrollingAgentId: enrollingAgentId || req.user.id,
      kycStatus: 'pending', suspended: false,
      mustChangePassword: true,   // ← member must reset on first login
      riskTier: 'green', riskScore: 100, shieldTokens: 0,
      createdAt: new Date().toISOString(), profile: { county }
    };
    await db.users.push(member);
    notifyAdmins('new_user','👥 Funeral Member Registered',
      `${fullName} (${phone}) · ${memberNumber} registered as funeral member by ${req.user.fullName}`);
    const agent = db.users.find(u => u.id === (enrollingAgentId || req.user.id));
    if (agent) agent.totalOnboarded = (agent.totalOnboarded||0) + 1;

    // SMS simulation — general login credentials
    console.log(`[SMS to ${phone}] Dear ${fullName}, you have been registered as a PikiShield Funeral member.`);
    console.log(`  Member No: ${memberNumber}`);
    console.log(`  Temporary password: ${tempPassword}`);
    console.log(`  ⚠️  You MUST change this password on first login at pikishield.co.ke`);

    const { password:_, ...safe } = member;
    res.status(201).json({
      member: safe, memberNumber,
      tempPassword,   // agent shows this to the member (or SMS delivers it)
      message: `Member registered. Temp login: ${phone} / ${tempPassword} — must change on first login.`
    });
  } catch(e) { res.status(500).json({ error:'Member registration failed: '+e.message }); }
});

// ── Register NOK ──────────────────────────────────────────────────────────────
router.post('/register-nok', authenticate, async (req, res) => {
  try {
    const { fullName, phone, nationalId, password, policyId } = req.body;
    if (!fullName || !phone || !nationalId || !password || !policyId)
      return res.status(400).json({ error:'All NOK fields required' });
    const policy = db.policies.find(p => p.id === policyId && p.userId === req.user.id && p.type === 'funeral');
    if (!policy) return res.status(404).json({ error:'Funeral policy not found' });
    if (db.users.find(u => u.phone === phone))
      return res.status(409).json({ error:'Phone already registered' });
    const nokNumber = `NOK-${req.user.nationalId?.toString().slice(0,4)||'0000'}-${Math.floor(1000+Math.random()*9000)}`;
    const hashed = await bcrypt.hash(password, 10);
    const nok = {
      id:uuidv4(), phone, fullName, nationalId, nokNumber,
      password:hashed, role:'nok', suspended:false,
      principalId:req.user.id, principalName:req.user.fullName, policyId,
      verified:false, kycStatus:'pending',
      riskTier:'green', riskScore:100, shieldTokens:0,
      createdAt:new Date().toISOString(), profile:{}
    };
    await db.users.push(nok);
    policy.nokId    = nok.id;
    policy.nokNumber = nokNumber;
    console.log(`[SMS to ${phone}] Dear ${fullName}, you are registered as Next of Kin for ${req.user.fullName} on PikiShield. Login: Phone ${phone}, NOK#: ${nokNumber}. Login at pikishield.co.ke`);
    notifyAdmins('new_nok','🔗 NOK Account Created',`${fullName} registered as NOK for ${req.user.fullName}. NOK#: ${nokNumber}`);
    const { password:_, ...safe } = nok;
    res.status(201).json({ nok:safe, nokNumber, message:`NOK account created. NOK login: ${nokNumber}` });
  } catch(e) { res.status(500).json({ error:'NOK registration failed: '+e.message }); }
});

// ── Register Agent (admin only) ───────────────────────────────────────────────
router.post('/register-agent', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error:'Admin only' });
    const { fullName, phone, email, nationalId, password, region } = req.body;
    if (!fullName || !phone || !nationalId || !password)
      return res.status(400).json({ error:'Required fields missing' });
    if (db.users.find(u => u.phone === phone))
      return res.status(409).json({ error:'Phone already registered' });
    const agentCode = `AGT-${Math.random().toString(36).slice(2,7).toUpperCase()}`;
    const hashed = await bcrypt.hash(password, 10);
    const agent = {
      id:uuidv4(), phone, email, fullName, nationalId,
      password:hashed, role:'agent', agentCode, suspended:false,
      region:region||'Nairobi', verified:true, kycStatus:'approved',
      totalOnboarded:0, riskTier:'green', riskScore:100, shieldTokens:0,
      createdAt:new Date().toISOString(), profile:{}
    };
    await db.users.push(agent);
    const { password:_, ...safe } = agent;
    res.status(201).json({ agent:safe, agentCode, message:`Agent created. Code: ${agentCode}` });
  } catch { res.status(500).json({ error:'Agent creation failed' }); }
});

// ── Forgot / Reset Password ───────────────────────────────────────────────────
router.post('/forgot-password', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error:'Phone or email required' });
  const user = db.users.find(u => u.phone===phone || u.email===phone || u.nokNumber===phone);
  if (!user) return res.status(404).json({ error:'No account found' });
  const otp    = Math.floor(100000+Math.random()*900000).toString();
  const expiry = new Date(Date.now()+15*60*1000).toISOString();
  if (!db.otps) db.otps = [];
  db.otps = db.otps.filter(o => o.userId !== user.id);
  await db.otps.push({ userId:user.id, otp, expiry });
  console.log(`[DEMO OTP] ${phone} → ${otp}`);
  res.json({ message:`OTP sent to ${phone}`, demoOtp:otp });
});

router.post('/verify-otp', async (req, res) => {
  const { phone, otp } = req.body;
  const user = db.users.find(u => u.phone===phone || u.email===phone || u.nokNumber===phone);
  if (!user) return res.status(404).json({ error:'User not found' });
  if (!db.otps) return res.status(400).json({ error:'No OTP found' });
  const record = db.otps.find(o => o.userId===user.id);
  if (!record) return res.status(400).json({ error:'No OTP requested' });
  if (new Date(record.expiry) < new Date()) return res.status(400).json({ error:'OTP expired' });
  if (record.otp !== otp.trim()) return res.status(400).json({ error:'Incorrect OTP' });
  const resetToken = jwt.sign({ userId:user.id, purpose:'reset' }, JWT_SECRET, { expiresIn:'10m' });
  db.otps = db.otps.filter(o => o.userId !== user.id);
  res.json({ resetToken, message:'OTP verified. Set new password.' });
});

router.post('/reset-password', async (req, res) => {
  const { resetToken, newPassword } = req.body;
  if (!resetToken || !newPassword) return res.status(400).json({ error:'Token and new password required' });
  try {
    const decoded = jwt.verify(resetToken, JWT_SECRET);
    if (decoded.purpose !== 'reset') return res.status(400).json({ error:'Invalid token' });
    if (newPassword.length < 8) return res.status(400).json({ error:'Password must be 8+ characters' });
    const user = db.users.find(u => u.id === decoded.userId);
    if (!user) return res.status(404).json({ error:'User not found' });
    user.password = await bcrypt.hash(newPassword, 10);
    res.json({ message:'Password reset successful.' });
  } catch { res.status(400).json({ error:'Invalid or expired token' }); }
});

router.post('/change-password', authenticate, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error:'Both passwords required' });
  const valid = await bcrypt.compare(currentPassword, req.user.password);
  if (!valid) return res.status(400).json({ error:'Current password is incorrect — check the temporary password your agent gave you' });
  if (newPassword.length < 8) return res.status(400).json({ error:'Min 8 characters' });
  req.user.password = await bcrypt.hash(newPassword, 10);
  req.user.mustChangePassword = false;
  saveDb();   // ← persist so new password survives server restart
  res.json({ message:'Password changed successfully.' });
});

// ── Notifications ─────────────────────────────────────────────────────────────
router.get('/notifications', authenticate, async (req, res) => {
  try {
    const notes = (db.notifications._cache || []).filter(n => n.userId===req.user.id)
      .sort((a,b) => new Date(b.createdAt)-new Date(a.createdAt)).slice(0,50);
    res.json({ notifications:notes, unread:notes.filter(n=>!n.read).length });
  } catch(e) { res.json({ notifications:[], unread:0 }); }
});

// read-all MUST come before :id/read
router.patch('/notifications/read-all', authenticate, async (req, res) => {
  if (!db.notifications) db.notifications = [];
  db.notifications.filter(n => n.userId===req.user.id).forEach(n => { n.read=true; });
  res.json({ ok:true });
});

router.patch('/notifications/:id/read', authenticate, async (req, res) => {
  if (!db.notifications) db.notifications = [];
  const n = db.notifications.find(x => x.id===req.params.id && x.userId===req.user.id);
  if (n) n.read = true;
  res.json({ ok:true });
});

router.get('/me', authenticate, async (req, res) => {
  const { password:_, ...safe } = req.user;
  const safeUser = {...safe, profile:(safe.profile&&Object.keys(safe.profile).length>0)?safe.profile:null};
  res.json(safeUser);
});

// ── First-run setup: register the first admin ──────────────────────────────────
// Only works if NO admin exists yet. Used to register the owner's own account.
router.get('/setup-status', async (req, res) => {
  const adminExists = db.users.some(u => u.role === 'admin');
  res.json({ setupRequired: !adminExists });
});

router.post('/setup-admin', async (req, res) => {
  try {
    // Block if admin already exists
    if (db.users.some(u => u.role === 'admin'))
      return res.status(403).json({ error: 'Setup already complete. Log in as existing admin.' });

    const { fullName, phone, email, password } = req.body;
    if (!fullName || !phone || !password)
      return res.status(400).json({ error: 'Full name, phone and password are required' });
    if (password.length < 8)
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    if (db.users.find(u => u.phone === phone))
      return res.status(409).json({ error: 'Phone number already registered' });

    const hashed = await bcrypt.hash(password, 10);
    const admin = {
      id: uuidv4(), phone, email: email||null, fullName,
      password: hashed, role: 'admin',
      verified: true, kycStatus: 'approved', suspended: false,
      riskTier: 'green', riskScore: 100, shieldTokens: 0,
      createdAt: new Date().toISOString(), profile: {}
    };
    await db.users.push(admin);
    // Remove the seeded default admin if present (keeps only this real one)
    const defaultIdx = db.users.findIndex(u => u.phone === '+254700000001' && u.id !== admin.id);
    if (defaultIdx !== -1) await db.users.splice(defaultIdx, 1);

    const token = jwt.sign({ userId:admin.id, role:'admin' }, JWT_SECRET, { expiresIn:'7d' });
    const { password:_, ...safe } = admin;
    console.log(`[SETUP] First admin registered: ${fullName} | ${phone}`);
    res.status(201).json({ token, user:safe, message: 'Admin account created. You are now logged in.' });
  } catch(e) { res.status(500).json({ error: 'Setup failed: ' + e.message }); }
});

module.exports = { router, pushNotification, notifyAdmins };
