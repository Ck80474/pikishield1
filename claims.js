const express = require('express');
const router  = express.Router();
const { v4: uuidv4 } = require('uuid');
const { db, saveDb } = require('./db');
const { authenticate, requireAdmin } = require('./auth_middleware');

// Generate readable claim ID: CLM-BAIL-00042
async function genClaimId(type) {
  const prefix = { bail:'BAIL', income:'STIP', funeral:'FUNL' }[type] || 'CLM';
  const seq = String(db.claims.length + 1).padStart(5, '0');
  return `CLM-${prefix}-${seq}`;
}

const WAITING_DAYS = 90; // 3 months for ALL claim types

async function notifyAdmins(type, title, body) {
  if (!db.notifications) db.notifications = [];
  for (const a of db.users.filter(u => u.role==='admin')) {
    await db.notifications.push({ id:uuidv4(), userId:a.id, type, title, body, read:false, createdAt:new Date().toISOString() });
  }
}

async function computeFraudScore(amount, user, policy) {
  let score = 5;
  if (user.riskTier === 'red')    score += 30;
  if (user.riskTier === 'yellow') score += 15;
  if (policy.claimsUsed >= 1)    score += 20;
  if (amount > 10000)             score += 10;
  const recent = db.claims.filter(c =>
    c.userId === user.id && new Date(c.submittedAt) > new Date(Date.now()-30*24*60*60*1000));
  if (recent.length > 1) score += 25;
  return Math.min(score, 100);
}

// GET / — user sees own; admin sees all; NOK sees own
router.get('/', authenticate, async (req, res) => {
  let claims;
  if (req.user.role === 'admin') {
    claims = db.claims.map(c => {
      const u = db.users.find(x => x.id === c.userId);
      return { ...c, userName:u?.fullName, userPhone:u?.phone, memberNumber:u?.memberNumber };
    });
  } else {
    claims = db.claims.filter(c => c.userId === req.user.id);
  }
  claims.sort((a,b) => new Date(b.submittedAt)-new Date(a.submittedAt));
  res.json(claims);
});

router.get('/:id', authenticate, async (req, res) => {
  const claim = db.claims.find(c => c.id === req.params.id);
  if (!claim) return res.status(404).json({ error:'Claim not found' });
  if (req.user.role !== 'admin' && claim.userId !== req.user.id)
    return res.status(403).json({ error:'Forbidden' });
  const u = db.users.find(x => x.id === claim.userId);
  res.json({ ...claim, userName:u?.fullName, userPhone:u?.phone, memberNumber:u?.memberNumber });
});

router.post('/', authenticate, async (req, res) => {
  const { policyId, type, documents, description } = req.body;
  const amount = Number(req.body.amount);
  if (!policyId || !type || !description)
    return res.status(400).json({ error:'Missing required fields' });
  if (isNaN(amount) || amount < 0)
    return res.status(400).json({ error:'Invalid amount' });

  let policy;
  if (req.user.role === 'nok') {
    policy = db.policies.find(p =>
      p.type === 'funeral' && p.status === 'active' &&
      (p.id === policyId || p.nokId === req.user.id || p.id === req.user.policyId)
    );
    if (!policy) return res.status(404).json({ error:'No linked active funeral policy found.' });
    if (type !== 'funeral') return res.status(400).json({ error:'NOK accounts can only file funeral claims' });
    // NOK also subject to 3-month waiting period
    const policyAgeDays = (Date.now() - new Date(policy.startDate)) / (1000*60*60*24);
    if (policyAgeDays < WAITING_DAYS) {
      const remaining = Math.ceil(WAITING_DAYS - policyAgeDays);
      return res.status(400).json({ error:`Funeral claims open after 3 months of active cover. ${remaining} day(s) remaining.` });
    }
  } else {
    policy = db.policies.find(p => p.id === policyId && p.userId === req.user.id);
    if (!policy) return res.status(404).json({ error:'Policy not found' });
    const policyAgeDays = (Date.now() - new Date(policy.startDate)) / (1000*60*60*24);
    if (policyAgeDays < WAITING_DAYS) {
      const remaining = Math.ceil(WAITING_DAYS - policyAgeDays);
      return res.status(400).json({ error:`Claims open after 3 months (90 days) of active cover. ${remaining} day(s) remaining.` });
    }
  }

  if (policy.status !== 'active') return res.status(400).json({ error:'Policy is not active' });
  const maxCoverage = policy.coverages[type];
  if (maxCoverage === undefined) return res.status(400).json({ error:`Claim type "${type}" not covered` });
  if (amount > maxCoverage) return res.status(400).json({ error:`KES ${amount.toLocaleString()} exceeds coverage of KES ${maxCoverage.toLocaleString()}` });

  // ── Year limit checks ────────────────────────────────────────────────────────
  // Count both pending AND approved claims this year — prevents gaming the limit
  const yearClaims = db.claims.filter(c =>
    c.userId === req.user.id &&
    c.type   === type &&
    ['pending','approved'].includes(c.status) &&
    new Date(c.submittedAt) > new Date(Date.now() - 365*24*60*60*1000)
  );

  if (type === 'bail' && yearClaims.length >= 2)
    return res.status(400).json({ error: 'Annual bail limit reached — maximum 2 bail claims per year.' });

  if (type === 'income' && yearClaims.length >= 2)
    return res.status(400).json({ error: 'Annual stipend limit reached — maximum 2 stipend claims per year.' });

  // Stipend: must also be at least 6 months since last approved/pending stipend
  if (type === 'income' && yearClaims.length >= 1) {
    const lastClaim = yearClaims.sort((a,b) => new Date(b.submittedAt)-new Date(a.submittedAt))[0];
    const monthsSince = (Date.now() - new Date(lastClaim.submittedAt)) / (1000*60*60*24*30);
    if (monthsSince < 6)
      return res.status(400).json({ error: `Must wait 6 months between stipend claims. ${Math.ceil(6-monthsSince)} month(s) remaining.` });
  }

  const fraudScore = computeFraudScore(amount, req.user, policy);
  const autoApprove = fraudScore < 20 && amount <= 3000 && type !== 'funeral';

  const claim = {
    id: genClaimId(type),
    userId:req.user.id,
    submitterRole:req.user.role,
    policyId, type,
    status: autoApprove ? 'approved' : 'pending',
    amount:Number(amount),
    description,
    submittedAt:new Date().toISOString(),
    approvedAt: autoApprove ? new Date(Date.now()+4*60*60*1000).toISOString() : null,
    documents:documents||[],
    fraudScore
  };
  await db.claims.push(claim);
  notifyAdmins('new_claim',`📋 New ${type.toUpperCase()} Claim`,
    `${req.user.fullName} (${req.user.role}) filed KES ${Number(amount).toLocaleString()} ${type} claim. Fraud: ${fraudScore}/100`);

  if (autoApprove) {
    policy.claimsUsed++;
    await db.transactions.push({ id:uuidv4(), userId:req.user.id, type:'claim_payout',
      amount:Number(amount), description:`Claim payout — ${type} (auto-approved)`,
      date:claim.approvedAt, status:'completed', method:'mpesa' });
  }

  const user = db.users.find(u => u.id === req.user.id);
  if (user) {
    user.riskScore = Math.max(0, user.riskScore-5);
    if (user.riskScore < 40) user.riskTier = 'red';
    else if (user.riskScore < 65) user.riskTier = 'yellow';
  }

  res.status(201).json({ claim, message:autoApprove?'Claim auto-approved! Payout in 4 hours.':'Claim submitted for review.' });
});

router.patch('/:id/status', authenticate, requireAdmin, async (req, res) => {
  const { status, note } = req.body;
  const idx = db.claims.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error:'Claim not found' });
  db.claims[idx].status = status;
  db.claims[idx].adminNote = note;
  db.claims[idx].reviewedBy = req.user.fullName;
  db.claims[idx].reviewedAt = new Date().toISOString();
  if (status === 'approved') {
    db.claims[idx].approvedAt = new Date().toISOString();
    const policy = db.policies.find(p => p.id === db.claims[idx].policyId);
    if (policy) policy.claimsUsed++;
    await db.transactions.push({ id:uuidv4(), userId:db.claims[idx].userId, type:'claim_payout',
      amount:db.claims[idx].amount, description:`Claim payout — ${db.claims[idx].type}`,
      date:new Date().toISOString(), status:'completed', method:'mpesa' });
    // Notify claimant
    if (!db.notifications) db.notifications = [];
    await db.notifications.push({ id:uuidv4(), userId:db.claims[idx].userId,
      type:'payment', title:'✅ Claim Approved',
      body:`Your ${db.claims[idx].type} claim of KES ${db.claims[idx].amount.toLocaleString()} has been approved. Payout via M-Pesa shortly.`,
      read:false, createdAt:new Date().toISOString() });
  } else if (status === 'rejected') {
    if (!db.notifications) db.notifications = [];
    await db.notifications.push({ id:uuidv4(), userId:db.claims[idx].userId,
      type:'system', title:'❌ Claim Rejected',
      body:`Your ${db.claims[idx].type} claim was rejected. ${note||''}`,
      read:false, createdAt:new Date().toISOString() });
  }
  res.json({ claim:db.claims[idx], message:`Claim ${status}` });
});

module.exports = router;
