const express = require('express');
const router  = express.Router();
const { v4: uuidv4 } = require('uuid');
const { db, saveDb } = require('./db');
const { authenticate } = require('./auth_middleware');

// Generate readable policy ID: POL-BAIL-00042
async function genPolicyId(type) {
  const prefix = { bail:'BAIL', bail_income:'BSTI', funeral:'FUNL' }[type] || 'POL';
  const seq = String(db.policies.length + 1).padStart(5, '0');
  return `POL-${prefix}-${seq}`;
}

const PACKAGES = {
  bail: {
    name: 'Bail Protection',
    dailyContribution: 20,
    coverages: { bail: 20000 },
    description: 'Traffic arrest bail up to KES 20,000. Max 2 claims/year.',
    maxClaimsPerYear: 2
  },
  bail_income: {
    name: 'Bail + Stipend Bundle',
    dailyContribution: 40,
    coverages: { bail: 20000, income: 15000 },
    description: 'Bail KES 20,000 + income stipend KES 15,000. Max 2 bail claims/year and 2 stipend claims/year.',
    maxClaimsPerYear: 2
  },
  funeral: {
    name: 'Funeral Protection',
    dailyContribution: 15,
    coverages: { funeral: 200000 },
    description: 'Funeral cover up to KES 200,000. No minimum claim amount.',
    maxClaimsPerYear: 3
  },
};

router.get('/packages', async (req, res) => res.json(PACKAGES));

router.get('/', authenticate, async (req, res) => {
  let policies;
  if (req.user.role === 'nok') {
    policies = db.policies.filter(p =>
      p.type === 'funeral' && p.status === 'active' &&
      (p.nokId === req.user.id || p.id === req.user.policyId)
    );
  } else {
    policies = db.policies.filter(p => p.userId === req.user.id);
  }
  res.json(policies);
});

router.get('/:id', authenticate, async (req, res) => {
  const policy = db.policies.find(p => p.id === req.params.id && p.userId === req.user.id);
  if (!policy) return res.status(404).json({ error:'Policy not found' });
  res.json(policy);
});

router.post('/subscribe', authenticate, async (req, res) => {
  const { type, members } = req.body;
  if (!PACKAGES[type]) return res.status(400).json({ error:'Invalid package type' });
  const existing = db.policies.find(p => p.userId === req.user.id && p.type === type && p.status === 'active');
  if (existing) return res.status(409).json({ error:'Already subscribed to this package' });

  // Validate funeral members — max age 70
  if ((type === 'funeral' || type === 'full') && members?.length) {
    for (const m of members) {
      if (!m.name) continue;
      const age = parseInt(m.age, 10);
      if (isNaN(age) || age < 1) return res.status(400).json({ error:`Please enter a valid age for member: ${m.name}` });
      if (age > 70) return res.status(400).json({ error:`Member "${m.name}" is ${age} years old. Maximum age for funeral cover is 70 years.` });
    }
  }

  const pkg = PACKAGES[type];
  const policy = {
    id: genPolicyId(type), userId: req.user.id, type,
    name: pkg.name, status: 'active',
    dailyContribution: pkg.dailyContribution,
    startDate: new Date().toISOString(),
    nextPayment: new Date(Date.now()+24*60*60*1000).toISOString(),
    coverages: pkg.coverages,
    claimsUsed: 0, totalContributed: 0,
    members: (type === 'funeral' || type === 'full') ? (members||[]) : undefined
  };
  await db.policies.push(policy);

  await db.transactions.push({ id:uuidv4(), userId:req.user.id, type:'contribution',
    amount:pkg.dailyContribution, description:`First day contribution — ${pkg.name}`,
    date:new Date().toISOString(), status:'completed', method:'mpesa' });
  policy.totalContributed = pkg.dailyContribution;

  const user = db.users.find(u => u.id === req.user.id);
  if (user) user.shieldTokens = (user.shieldTokens||0) + 10; // enrolment token

  res.status(201).json({ policy, message:`Successfully enrolled in ${pkg.name}` });
});

router.delete('/:id', authenticate, async (req, res) => {
  const idx = db.policies.findIndex(p => p.id === req.params.id && p.userId === req.user.id);
  if (idx === -1) return res.status(404).json({ error:'Policy not found' });
  db.policies[idx].status = 'cancelled';
  db.policies[idx].cancelledAt = new Date().toISOString();
  res.json({ message:'Policy cancelled' });
});

module.exports = router;
