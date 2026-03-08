const express  = require('express');
const router   = express.Router();
const https    = require('https');
const { v4: uuidv4 } = require('uuid');
const { db }   = require('./db');
const { authenticate, requireAdmin } = require('./auth_middleware');

// ─── Daraja helpers ────────────────────────────────────────────────────────────

/**
 * Get M-Pesa OAuth token from Safaricom Daraja
 * Requires MPESA_CONSUMER_KEY and MPESA_CONSUMER_SECRET in .env
 */
async function getDarajaToken() {
  const key    = process.env.MPESA_CONSUMER_KEY;
  const secret = process.env.MPESA_CONSUMER_SECRET;
  if (!key || !secret) throw new Error('M-Pesa credentials not configured. Set MPESA_CONSUMER_KEY and MPESA_CONSUMER_SECRET in .env');

  const credentials = Buffer.from(`${key}:${secret}`).toString('base64');
  const baseUrl = process.env.MPESA_ENV === 'production'
    ? 'api.safaricom.co.ke'
    : 'sandbox.safaricom.co.ke';

  return new Promise((resolve, reject) => {
    const options = {
      hostname: baseUrl,
      path: '/oauth/v1/generate?grant_type=client_credentials',
      method: 'GET',
      headers: { Authorization: `Basic ${credentials}` },
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        if (!data || data.trim() === '') {
          reject(new Error('Empty response from Daraja OAuth — verify MPESA_CONSUMER_KEY and MPESA_CONSUMER_SECRET'));
          return;
        }
        try {
          const json = JSON.parse(data);
          if (json.access_token) resolve(json.access_token);
          else reject(new Error('Failed to get Daraja token: ' + data.slice(0, 200)));
        } catch(e) { reject(new Error('Invalid OAuth response: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Generate Lipa Na M-Pesa password (Base64 of ShortCode+Passkey+Timestamp)
 */
async function getLNMPassword(timestamp) {
  const shortCode = process.env.MPESA_SHORTCODE;
  const passkey   = process.env.MPESA_PASSKEY;
  return Buffer.from(`${shortCode}${passkey}${timestamp}`).toString('base64');
}

async function getTimestamp() {
  return new Date().toISOString().replace(/[-:T.Z]/g,'').slice(0,14);
}

/**
 * Make a POST request to Daraja
 */
async function darajaPost(path, body, token) {
  const baseUrl = process.env.MPESA_ENV === 'production'
    ? 'api.safaricom.co.ke'
    : 'sandbox.safaricom.co.ke';

  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const options = {
      hostname: baseUrl,
      path,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
            if (!data || data.trim() === '') reject(new Error('Empty response from Daraja — check your MPESA credentials and shortcode'));
            else resolve(JSON.parse(data));
          }
          catch(e) { reject(new Error('Invalid JSON from Daraja: ' + data.slice(0,200))); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ─── STK Push (Lipa Na M-Pesa) ────────────────────────────────────────────────
router.post('/mpesa/initiate', authenticate, async (req, res) => {
  const { amount, phone, policyId, description } = req.body;
  if (!amount || !phone) return res.status(400).json({ error: 'Amount and phone required' });
  if (isNaN(Number(amount)) || Number(amount) < 1)
    return res.status(400).json({ error: 'Invalid amount' });

  const isConfigured = process.env.MPESA_CONSUMER_KEY && process.env.MPESA_SHORTCODE && process.env.MPESA_PASSKEY;

  // ── SIMULATION MODE (no .env keys set) ───────────────────────────────────
  if (!isConfigured) {
    console.log(`[M-PESA SIMULATE] STK Push to ${phone} for KES ${amount}`);
    const checkoutRequestId = `ws_CO_SIM_${Date.now()}`;
    const payment = {
      id: uuidv4(), userId: req.user.id, policyId: policyId||null,
      type: 'mpesa_stk', amount: Number(amount), phone,
      description: description || 'PikiShield contribution',
      status: 'pending', checkoutRequestId, mode: 'simulation',
      initiatedAt: new Date().toISOString(), completedAt: null, mpesaReceiptNumber: null,
    };
    if (!db.payments) db.payments = [];
    await db.payments.push(payment);

    // Auto-complete after 4 seconds in simulation
    setTimeout(async () => {
      const p = db.payments.find(x => x.id === payment.id);
      if (p && p.status === 'pending') {
        p.status = 'completed';
        p.completedAt = new Date().toISOString();
        p.mpesaReceiptNumber = `SIM${Math.random().toString(36).slice(2,9).toUpperCase()}`;
        await db.transactions.push({
          id: uuidv4(), userId: req.user.id, type: 'contribution',
          amount: p.amount, description: p.description,
          date: p.completedAt, status: 'completed', method: 'mpesa',
          mpesaRef: p.mpesaReceiptNumber,
        });
        if (policyId) {
          const pol = db.policies.find(x => x.id === policyId);
          if (pol) pol.totalContributed = (pol.totalContributed||0) + p.amount;
        }
      }
    }, 4000);

    return res.json({
      checkoutRequestId, paymentId: payment.id, mode: 'simulation',
      message: `[SIMULATION] STK Push sent to ${phone}. Auto-completes in 4 seconds.`,
    });
  }

  // ── LIVE MODE (real Daraja API) ────────────────────────────────────────────
  try {
    const token     = await getDarajaToken();
    const timestamp = getTimestamp();
    const password  = getLNMPassword(timestamp);
    const safPhone  = phone.replace(/^\+/, '').replace(/^0/, '254'); // normalise to 254XXXXXXXXX

    const stkBody = {
      BusinessShortCode: process.env.MPESA_SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: Math.ceil(Number(amount)),
      PartyA: safPhone,
      PartyB: process.env.MPESA_SHORTCODE,
      PhoneNumber: safPhone,
      CallBackURL: `${process.env.BACKEND_URL}/api/payments/mpesa/callback`,
      AccountReference: `PIKI-${req.user.memberNumber || req.user.id.slice(0,8).toUpperCase()}`,
      TransactionDesc: description || 'PikiShield contribution',
    };

    const response = await darajaPost('/mpesa/stkpush/v1/processrequest', stkBody, token);

    if (response.ResponseCode !== '0') {
      return res.status(400).json({ error: response.ResponseDescription || 'STK Push failed' });
    }

    const payment = {
      id: uuidv4(), userId: req.user.id, policyId: policyId||null,
      type: 'mpesa_stk', amount: Number(amount), phone: safPhone,
      description: description || 'PikiShield contribution',
      status: 'pending',
      checkoutRequestId: response.CheckoutRequestID,
      merchantRequestId: response.MerchantRequestID,
      mode: 'live',
      initiatedAt: new Date().toISOString(), completedAt: null, mpesaReceiptNumber: null,
    };
    if (!db.payments) db.payments = [];
    await db.payments.push(payment);

    console.log(`[M-PESA LIVE] STK Push initiated: ${response.CheckoutRequestID} | KES ${amount} | ${safPhone}`);

    res.json({
      checkoutRequestId: response.CheckoutRequestID,
      paymentId: payment.id, mode: 'live',
      message: `M-Pesa prompt sent to ${phone}. Enter your PIN to complete.`,
    });
  } catch(err) {
    console.error('[M-PESA ERROR]', err.message);
    res.status(500).json({ error: 'M-Pesa service error: ' + err.message });
  }
});

// ─── Daraja STK Callback (Safaricom calls this URL) ───────────────────────────
router.post('/mpesa/callback', async (req, res) => {
  // Always respond 200 immediately to Safaricom
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });

  try {
    const { Body } = req.body;
    if (!Body || !Body.stkCallback) return;

    const cb     = Body.stkCallback;
    const reqId  = cb.CheckoutRequestID;
    const code   = cb.ResultCode;

    const payment = (db.payments||[]).find(p => p.checkoutRequestId === reqId);
    if (!payment) {
      console.warn('[M-PESA CALLBACK] Payment not found:', reqId);
      return;
    }

    if (code === 0) {
      // Success — extract metadata
      const meta = {};
      (cb.CallbackMetadata?.Item || []).forEach(i => { meta[i.Name] = i.Value; });

      payment.status            = 'completed';
      payment.completedAt       = new Date().toISOString();
      payment.mpesaReceiptNumber = meta.MpesaReceiptNumber || null;
      payment.mpesaTransDate    = meta.TransactionDate     || null;
      payment.mpesaPhone        = meta.PhoneNumber         || null;

      // Record transaction
      await db.transactions.push({
        id: uuidv4(), userId: payment.userId, type: 'contribution',
        amount: payment.amount, description: payment.description,
        date: payment.completedAt, status: 'completed', method: 'mpesa',
        mpesaRef: payment.mpesaReceiptNumber,
      });

      // Update policy
      if (payment.policyId) {
        const pol = (db.policies||[]).find(p => p.id === payment.policyId);
        if (pol) pol.totalContributed = (pol.totalContributed||0) + payment.amount;
      }

      console.log(`[M-PESA CALLBACK] ✅ Payment confirmed: ${payment.mpesaReceiptNumber} | KES ${payment.amount} | User: ${payment.userId}`);
    } else {
      payment.status      = 'failed';
      payment.failedAt    = new Date().toISOString();
      payment.failReason  = cb.ResultDesc || 'Payment cancelled or failed';
      console.log(`[M-PESA CALLBACK] ❌ Payment failed: ${reqId} | Code: ${code} | ${cb.ResultDesc}`);
    }
  } catch(err) {
    console.error('[M-PESA CALLBACK ERROR]', err.message);
  }
});

// ─── Check STK Push status ─────────────────────────────────────────────────────
router.get('/mpesa/status/:paymentId', authenticate, async (req, res) => {
  if (!db.payments) return res.status(404).json({ error: 'Payment not found' });
  const p = db.payments.find(p => p.id === req.params.paymentId && p.userId === req.user.id);
  if (!p) return res.status(404).json({ error: 'Payment not found' });
  const { userId:_, ...safe } = p;
  res.json(safe);
});

// ─── Query STK status from Daraja (manual check) ─────────────────────────────
router.post('/mpesa/query/:paymentId', authenticate, async (req, res) => {
  const payment = (db.payments||[]).find(p => p.id === req.params.paymentId && p.userId === req.user.id);
  if (!payment) return res.status(404).json({ error: 'Payment not found' });
  if (payment.mode === 'simulation') return res.json(payment);

  try {
    const token     = await getDarajaToken();
    const timestamp = getTimestamp();
    const body = {
      BusinessShortCode: process.env.MPESA_SHORTCODE,
      Password: getLNMPassword(timestamp),
      Timestamp: timestamp,
      CheckoutRequestID: payment.checkoutRequestId,
    };
    const result = await darajaPost('/mpesa/stkpushquery/v1/query', body, token);
    res.json({ payment, darajaResult: result });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── B2C Payout (for claim disbursements) ─────────────────────────────────────
router.post('/mpesa/b2c-payout', authenticate, requireAdmin, async (req, res) => {
  const { phone, amount, occasion, remarks } = req.body;
  if (!phone || !amount) return res.status(400).json({ error: 'Phone and amount required' });

  const isConfigured = process.env.MPESA_B2C_INITIATOR && process.env.MPESA_B2C_SECURITY_CREDENTIAL;

  if (!isConfigured) {
    console.log(`[B2C SIMULATE] Payout of KES ${amount} to ${phone}`);
    return res.json({
      mode: 'simulation',
      message: `[SIMULATION] B2C payout of KES ${amount} to ${phone} initiated.`,
      ConversationID: `SIM-B2C-${Date.now()}`,
    });
  }

  try {
    const token = await getDarajaToken();
    const body = {
      InitiatorName:      process.env.MPESA_B2C_INITIATOR,
      SecurityCredential: process.env.MPESA_B2C_SECURITY_CREDENTIAL,
      CommandID:          'BusinessPayment',
      Amount:             Math.ceil(Number(amount)),
      PartyA:             process.env.MPESA_B2C_SHORTCODE || process.env.MPESA_SHORTCODE,
      PartyB:             phone.replace(/^\+/, '').replace(/^0/, '254'),
      Remarks:            remarks || 'PikiShield claim payout',
      QueueTimeOutURL:    `${process.env.BACKEND_URL}/api/payments/mpesa/b2c-timeout`,
      ResultURL:          `${process.env.BACKEND_URL}/api/payments/mpesa/b2c-result`,
      Occasion:           occasion || 'Claim payout',
    };
    const result = await darajaPost('/mpesa/b2c/v1/paymentrequest', body, token);
    console.log(`[B2C PAYOUT] ${phone} | KES ${amount} | ${result.ConversationID}`);
    res.json(result);
  } catch(err) {
    console.error('[B2C ERROR]', err.message);
    res.status(500).json({ error: 'B2C payout failed: ' + err.message });
  }
});

// ─── B2C result callbacks ─────────────────────────────────────────────────────
router.post('/mpesa/b2c-result',  async (req, res) => { console.log('[B2C RESULT]',  JSON.stringify(req.body)); res.json({}); });
router.post('/mpesa/b2c-timeout', async (req, res) => { console.log('[B2C TIMEOUT]', JSON.stringify(req.body)); res.json({}); });

// ─── Manual / bank payment ────────────────────────────────────────────────────
router.post('/manual', authenticate, async (req, res) => {
  const { amount, method, policyId, description, cardLast4 } = req.body;
  if (!amount || !method) return res.status(400).json({ error: 'Amount and method required' });
  const payment = {
    id: uuidv4(), userId: req.user.id, policyId: policyId||null,
    type: method, amount: Number(amount),
    description: description || 'Manual payment',
    status: 'completed', cardLast4: cardLast4||null,
    initiatedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    reference: `REF-${Math.random().toString(36).slice(2,10).toUpperCase()}`,
  };
  if (!db.payments) db.payments = [];
  await db.payments.push(payment);
  await db.transactions.push({
    id: uuidv4(), userId: req.user.id, type: 'contribution',
    amount: Number(amount), description: payment.description,
    date: payment.completedAt, status: 'completed', method,
    reference: payment.reference,
  });
  if (policyId) {
    const pol = db.policies.find(p => p.id === policyId);
    if (pol) pol.totalContributed = (pol.totalContributed||0) + Number(amount);
  }
  res.json({ payment, message: `Payment of KES ${Number(amount).toLocaleString()} recorded via ${method}` });
});

// ─── Payment history ──────────────────────────────────────────────────────────
router.get('/history', authenticate, async (req, res) => {
  if (!db.payments) return res.json([]);
  const payments = db.payments
    .filter(p => p.userId === req.user.id)
    .sort((a,b) => new Date(b.initiatedAt) - new Date(a.initiatedAt));
  res.json(payments);
});

// ─── Admin: all payments ──────────────────────────────────────────────────────
router.get('/admin/all', authenticate, requireAdmin, async (req, res) => {
  if (!db.payments) return res.json([]);
  const payments = db.payments.map(p => {
    const user = db.users.find(u => u.id === p.userId);
    return { ...p, userName: user?.fullName, userPhone: user?.phone };
  }).sort((a,b) => new Date(b.initiatedAt) - new Date(a.initiatedAt));
  res.json(payments);
});

module.exports = router;
