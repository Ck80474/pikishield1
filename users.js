const express = require('express');
const router  = express.Router();
const { v4: uuidv4 } = require('uuid');
const { db, saveDb } = require('./db');
const { authenticate, requireAdmin } = require('./auth_middleware');

// ── Agent dashboard ────────────────────────────────────────────────────────────
router.get('/agent/dashboard', authenticate, async (req, res) => {
  if (req.user.role !== 'agent') return res.status(403).json({ error: 'Agent access only' });
  const myRiders  = db.users.filter(u => u.agentId === req.user.id);
  const myMembers = db.users.filter(u => u.enrollingAgentId === req.user.id && u.role === 'member');
  const myAll     = [...myRiders, ...myMembers];
  const myPolicies = db.policies.filter(p => myAll.some(r => r.id === p.userId) && p.status === 'active');
  const pendingKYC = myAll.filter(u => u.kycStatus === 'pending').length;
  res.json({
    agentCode: req.user.agentCode,
    region: req.user.region,
    totalOnboarded: req.user.totalOnboarded || myAll.length,
    activePolicies: myPolicies.length,
    pendingKYC,
    riders:  myRiders.map(({ password, ...u }) => ({...u, profile: (u.profile && Object.keys(u.profile).length>0)?u.profile:null})),
    members: myMembers.map(({ password, ...u }) => ({...u, profile: (u.profile && Object.keys(u.profile).length>0)?u.profile:null})),
  });
});

// ── Rider dashboard ────────────────────────────────────────────────────────────
router.get('/dashboard', authenticate, async (req, res) => {
  const user = req.user;
  const policies    = db.policies.filter(p => p.userId === user.id);
  const claims      = db.claims.filter(c => c.userId === user.id);
  const transactions = db.transactions.filter(t => t.userId === user.id);
  const totalPayouts = transactions.filter(t => t.type === 'claim_payout').reduce((s,t) => s+t.amount, 0);
  const pendingClaims  = claims.filter(c => c.status === 'pending').length;
  const approvedClaims = claims.filter(c => c.status === 'approved').length;

  const monthlyData = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(); d.setMonth(d.getMonth() - i);
    const monthStr = d.toLocaleString('default', { month: 'short' });
    const amt = transactions.filter(t => {
      const td = new Date(t.date);
      return td.getMonth()===d.getMonth() && td.getFullYear()===d.getFullYear() && t.type==='claim_payout';
    }).reduce((s,t) => s+t.amount, 0);
    monthlyData.push({ month: monthStr, amount: amt });
  }

  res.json({
    policies: policies.filter(p => p.status === 'active'),
    allPolicies: policies,
    totalPayouts,
    pendingClaims,
    approvedClaims,
    shieldTokens: user.shieldTokens,
    riskTier: user.riskTier,
    riskScore: user.riskScore,
    recentTransactions: transactions.filter(t => t.type !== 'contribution').slice(-5).reverse(),
    monthlyData,
  });
});

// ── Admin: main dashboard ──────────────────────────────────────────────────────
router.get('/admin/dashboard', authenticate, requireAdmin, async (req, res) => {
  try {
  const riders = db.users.filter(u => u.role === 'rider');
  const totalUsers  = riders.length;
  const activePolicies = db.policies.filter(p => p.status === 'active').length;
  const pendingClaims  = db.claims.filter(c => c.status === 'pending').length;
  const totalClaims    = db.claims.length;
  const totalPayouts   = db.transactions.filter(t => t.type==='claim_payout').reduce((s,t)=>s+t.amount,0);
  const totalRevenue   = db.transactions.filter(t => t.type==='contribution').reduce((s,t)=>s+t.amount,0);
  // Per-policy type contribution breakdown
  const contribByType = { bail:0, bail_income:0, funeral:0 };
  db.transactions.filter(t => t.type==='contribution').forEach(t => {
    const policy = db.policies.find(p => p.userId === t.userId && t.description?.includes(p.name));
    if (policy?.type && contribByType[policy.type] !== undefined) contribByType[policy.type] += t.amount;
  });
  const greenUsers  = db.users.filter(u => u.riskTier==='green').length;
  const yellowUsers = db.users.filter(u => u.riskTier==='yellow').length;
  const redUsers    = db.users.filter(u => u.riskTier==='red').length;

  const recentClaims = db.claims.slice(-5).reverse().map(c => {
    const u = db.users.find(x => x.id === c.userId);
    return { ...c, userName: u?.fullName };
  });

  // Bail / Funeral / Income breakdown
  const claimsByType = {
    bail:    db.claims.filter(c => c.type === 'bail'),
    funeral: db.claims.filter(c => c.type === 'funeral'),
    income:  db.claims.filter(c => c.type === 'income'),
  };

  res.json({
    totalUsers, activePolicies, pendingClaims, totalClaims,
    totalPayouts, totalRevenue, contribByType,
    riskDistribution: { green:greenUsers, yellow:yellowUsers, red:redUsers },
    recentClaims,
    claimsByType,
    suspended: db.users.filter(u => u.suspended).length,
    allUsers: db.users.filter(u => u.role !== 'admin').map(({ password, ...u }) => ({
      ...u,
      profile: (u.profile && Object.keys(u.profile).length > 0) ? u.profile : null
    })),
  });
  } catch(e) { console.error('Dashboard error:', e.message); res.status(500).json({ error: e.message }); }
});

// ── Admin: agent performance report ───────────────────────────────────────────
router.get('/admin/agents', authenticate, requireAdmin, async (req, res) => {
  const agents = db.users.filter(u => u.role === 'agent').map(a => {
    const riders  = db.users.filter(u => u.agentId === a.id);
    const members = db.users.filter(u => u.enrollingAgentId === a.id && u.role === 'member');
    const allOnboarded = [...riders, ...members];
    const policies = db.policies.filter(p => allOnboarded.some(r => r.id === p.userId) && p.status === 'active');
    const pendingKYC   = allOnboarded.filter(r => r.kycStatus === 'pending').length;
    const approvedKYC  = allOnboarded.filter(r => r.kycStatus === 'approved').length;
    const claimsCount  = db.claims.filter(c => allOnboarded.some(r => r.id === c.userId)).length;
    const lastActivity = allOnboarded.length
      ? allOnboarded.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt))[0].createdAt
      : a.createdAt;
    return {
      id: a.id, name: a.fullName, agentCode: a.agentCode, region: a.region,
      phone: a.phone, joinDate: a.createdAt,
      ridersCount: riders.length,
      membersCount: members.length,
      totalOnboarded: allOnboarded.length,
      activePolicies: policies.length,
      pendingKYC, approvedKYC, claimsCount,
      lastActivity,
      kycApprovalRate: allOnboarded.length ? Math.round((approvedKYC/allOnboarded.length)*100) : 0,
    };
  });
  res.json({ agents });
});

// ── Admin: pending onboarders (new users awaiting KYC review) ─────────────────
router.get('/admin/pending-onboards', authenticate, requireAdmin, async (req, res) => {
  // Exclude admins AND nok accounts — NOK don't need KYC review
  const pending = db.users
    .filter(u => u.kycStatus === 'pending' && u.role !== 'admin' && u.role !== 'nok')
    .map(({ password, ...u }) => {
      const docs = db.documents.filter(d => d.userId === u.id);
      const agent = u.agentId ? db.users.find(a => a.id === u.agentId) : null;
      return { ...u, docs, agentName: agent?.fullName, agentCode: agent?.agentCode, profile: (u.profile && Object.keys(u.profile).length>0)?u.profile:null };
    })
    .sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ pending });
});

// ── Transactions ───────────────────────────────────────────────────────────────
router.get('/transactions', authenticate, async (req, res) => {
  const txns = db.transactions
    .filter(t => t.userId === req.user.id && t.type !== 'contribution')
    .sort((a,b) => new Date(b.date) - new Date(a.date));
  res.json(txns);
});

// ── Token earn ─────────────────────────────────────────────────────────────────
router.post('/tokens/earn', authenticate, async (req, res) => {
  const { action } = req.body;
  const user = db.users.find(u => u.id === req.user.id);

  // Must be KYC-approved and have at least one active policy
  if (user.kycStatus !== 'approved')
    return res.status(403).json({ error: 'Your account must be verified by admin before earning tokens.' });
  const hasActivePolicy = db.policies.some(p => p.userId === user.id && p.status === 'active');
  if (!hasActivePolicy)
    return res.status(403).json({ error: 'You need an active policy to earn Shield Tokens.' });

  const rewards = {
    helmet_check:   { tokens: 3,  message: 'Helmet compliance verified! +3 tokens', cooldownHours: 24 },
    safety_quiz:    { tokens: 5,  message: 'Safety quiz completed! +5 tokens', cooldownHours: 24 },
    ev_charging:    { tokens: 4,  message: 'EV charging logged! +4 tokens', cooldownHours: 24 },
    referral:       { tokens: 20, message: 'Referral bonus! +20 tokens' },
    no_claim_month: { tokens: 10, message: 'No-claim month bonus! +10 tokens' },
  };
  const reward = rewards[action];
  if (!reward) return res.status(400).json({ error: 'Invalid action' });

  // Check cooldown for daily actions
  if (reward.cooldownHours) {
    const lastKey = `last_${action}`;
    const last = user.profile[lastKey];
    if (last && new Date() - new Date(last) < reward.cooldownHours * 3600000)
      return res.status(429).json({ error: `${action.replace('_',' ')} already done today. Try again tomorrow.` });
    user.profile[lastKey] = new Date().toISOString();
  }

  user.shieldTokens += reward.tokens;
  user.profile.safeRideStreak = (user.profile.safeRideStreak || 0) + 1;
  await db.transactions.push({ id:uuidv4(), userId:user.id, type:'token_earned',
    amount:reward.tokens, description:reward.message,
    date:new Date().toISOString(), status:'completed', method:'shield_tokens' });
  res.json({ tokens: user.shieldTokens, message: reward.message });
});

// ── Token redeem ───────────────────────────────────────────────────────────────
router.post('/tokens/redeem', authenticate, async (req, res) => {
  const { amount, reward } = req.body;
  const user = db.users.find(u => u.id === req.user.id);
  if (user.shieldTokens < amount) return res.status(400).json({ error: 'Insufficient tokens' });
  user.shieldTokens -= amount;
  await db.transactions.push({ id:uuidv4(), userId:user.id, type:'token_redeemed',
    amount, description:`Tokens redeemed for: ${reward}`,
    date:new Date().toISOString(), status:'completed', method:'shield_tokens' });
  res.json({ tokens: user.shieldTokens, message: `Redeemed ${amount} tokens for ${reward}` });
});

// ── Profile update ─────────────────────────────────────────────────────────────
router.patch('/profile', authenticate, async (req, res) => {
  const user = db.users.find(u => u.id === req.user.id);
  const { helmetCompliance, county } = req.body;
  if (helmetCompliance !== undefined) {
    user.profile.helmetCompliance = helmetCompliance;
    if (helmetCompliance) user.riskScore = Math.min(100, user.riskScore + 5);
  }
  if (county) user.profile.county = county;
  const { password:_, ...safe } = user;
  res.json(safe);
});

// ── Admin: approve / reject KYC ───────────────────────────────────────────────
router.patch('/:userId/approve-kyc', authenticate, requireAdmin, async (req, res) => {
  const user = db.users.find(u => u.id === req.params.userId);
  if (!user) return res.status(404).json({ error:'User not found' });
  user.kycStatus = 'approved';
  user.kycApprovedAt = new Date().toISOString();
  user.kycApprovedBy = req.user.fullName;
  if (!db.notifications) db.notifications = [];
  await db.notifications.push({ id:uuidv4(), userId:user.id, type:'system',
    title:'✅ KYC Approved',
    body:'Your identity has been verified. You are now fully active on PikiShield.',
    read:false, createdAt:new Date().toISOString() });
  const { password:_, ...safe } = user;
  res.json({ user:safe, message:'KYC approved' });
});

router.patch('/:userId/reject-kyc', authenticate, requireAdmin, async (req, res) => {
  const user = db.users.find(u => u.id === req.params.userId);
  if (!user) return res.status(404).json({ error:'User not found' });
  user.kycStatus = 'rejected';
  user.kycRejectedReason = req.body.reason || 'Documents incomplete';
  if (!db.notifications) db.notifications = [];
  await db.notifications.push({ id:uuidv4(), userId:user.id, type:'system',
    title:'❌ KYC Rejected',
    body:`Reason: ${user.kycRejectedReason}. Please re-upload your documents.`,
    read:false, createdAt:new Date().toISOString() });
  const { password:_, ...safe } = user;
  res.json({ user:safe, message:'KYC rejected' });
});

// ── Admin: suspend / unsuspend ─────────────────────────────────────────────────
router.patch('/:userId/suspend', authenticate, requireAdmin, async (req, res) => {
  const user = db.users.find(u => u.id === req.params.userId);
  if (!user) return res.status(404).json({ error:'User not found' });
  user.suspended = true;
  user.suspendedAt = new Date().toISOString();
  user.suspendReason = req.body.reason || 'Suspected fraud';
  user.suspendedBy = req.user.fullName;
  if (!db.notifications) db.notifications = [];
  await db.notifications.push({ id:uuidv4(), userId:user.id, type:'system',
    title:'⚠️ Account Suspended',
    body:`Your account has been suspended. Reason: ${user.suspendReason}. Contact support@pikishield.co.ke.`,
    read:false, createdAt:new Date().toISOString() });
  const { password:_, ...safe } = user;
  res.json({ user:safe, message:'Account suspended' });
});

router.patch('/:userId/unsuspend', authenticate, requireAdmin, async (req, res) => {
  const user = db.users.find(u => u.id === req.params.userId);
  if (!user) return res.status(404).json({ error:'User not found' });
  user.suspended = false;
  user.unsuspendedAt = new Date().toISOString();
  user.suspendReason = null;
  if (!db.notifications) db.notifications = [];
  await db.notifications.push({ id:uuidv4(), userId:user.id, type:'system',
    title:'✅ Account Reinstated',
    body:'Your account suspension has been lifted. You may continue using PikiShield.',
    read:false, createdAt:new Date().toISOString() });
  const { password:_, ...safe } = user;
  res.json({ user:safe, message:'Account reinstated' });
});

// ── Admin: Create Agent ───────────────────────────────────────────────────────
router.post('/admin/create-agent', authenticate, requireAdmin, async (req, res) => {
  try {
    const bcrypt = require('bcryptjs');
    const { fullName, phone, email, nationalId, region, password, commission } = req.body;
    if (!fullName || !phone || !nationalId || !region || !password)
      return res.status(400).json({ error: 'fullName, phone, nationalId, region and password are required' });
    if (db.users.find(u => u.phone === phone))
      return res.status(409).json({ error: 'Phone number already registered' });
    if (email && db.users.find(u => u.email === email))
      return res.status(409).json({ error: 'Email already registered' });
    const prefix = region.replace(/[^A-Z]/gi,'').toUpperCase().slice(0,3) || 'AGT';
    const existingAgents = db.users.filter(u => u.role === 'agent').length;
    const agentCode = `AGT-${prefix}-${String(existingAgents + 1).padStart(4,'0')}`;
    const hashed = await bcrypt.hash(password, 10);
    const agent = {
      id: uuidv4(), phone, email: email||null, fullName, nationalId,
      password: hashed, role: 'agent',
      agentCode, region,
      memberNumber: agentCode,   // use agentCode as memberNumber so it shows in table
      commissionRate: commission ? Number(commission) : 5,
      verified: true, kycStatus: 'approved', suspended: false,
      totalOnboarded: 0,
      riskTier: 'green', riskScore: 100, shieldTokens: 0,
      createdAt: new Date().toISOString(),
      profile: { county: region }
    };
    await db.users.push(agent);
    console.log(`[AGENT CREATED] ${fullName} | ${phone} | ${agentCode} | Region: ${region}`);
    const { password:_, ...safe } = agent;
    res.status(201).json({ agent: safe, user: safe, agentCode, message: `Agent created. Login: ${phone} / ${password}` });
  } catch(e) { res.status(500).json({ error: 'Agent creation failed: ' + e.message }); }
});

// ── Admin: Create Admin ───────────────────────────────────────────────────────
router.post('/admin/create-admin', authenticate, requireAdmin, async (req, res) => {
  try {
    const bcrypt = require('bcryptjs');
    const { fullName, phone, email, password } = req.body;
    if (!fullName || !phone || !password)
      return res.status(400).json({ error: 'Full name, phone and password are required' });
    if (password.length < 8)
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    if (db.users.find(u => u.phone === phone))
      return res.status(409).json({ error: 'Phone number already registered' });
    if (email && db.users.find(u => u.email === email))
      return res.status(409).json({ error: 'Email already registered' });
    const hashed = await bcrypt.hash(password, 10);
    const admin = {
      id: uuidv4(), phone, email: email||null, fullName,
      nationalId: null,
      password: hashed, role: 'admin',
      verified: true, kycStatus: 'approved', suspended: false,
      riskTier: 'green', riskScore: 100, shieldTokens: 0,
      createdAt: new Date().toISOString(), profile: {}
    };
    await db.users.push(admin);
    console.log(`[ADMIN CREATED] ${fullName} | ${phone} | by ${req.user.fullName}`);
    const { password:_, ...safe } = admin;
    res.status(201).json({ admin: safe, user: safe, message: `Admin account created for ${fullName}` });
  } catch(e) { res.status(500).json({ error: 'Admin creation failed: ' + e.message }); }
});

module.exports = router;
