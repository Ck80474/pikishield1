const jwt = require('jsonwebtoken');
const { db } = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'pikishield-secret-dev-2024';

// Routes that unverified members CAN still access
const KYC_OPEN_PATHS = [
  '/api/auth/',          // all auth routes — login, register, change-password, notifications
  '/api/documents/upload-kyc',
  '/api/documents/attach-kyc',
  '/api/users/me',
  '/api/users/profile',
  '/api/users/password',
  '/api/users/notifications',
];

function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer '))
    return res.status(401).json({ error: 'No token provided' });
  try {
    const decoded = jwt.verify(header.split(' ')[1], JWT_SECRET);
    const user = db.users.find(u => u.id === decoded.userId);
    if (!user) return res.status(401).json({ error: 'User not found' });
    if (user.suspended) return res.status(403).json({ error: 'Account suspended. Contact support@pikishield.co.ke.' });

    // KYC lock: riders/members whose KYC is still pending cannot perform transactions
    if (user.kycStatus === 'pending' && ['rider','member'].includes(user.role)) {
      const fullPath = req.originalUrl;
      const isOpen = KYC_OPEN_PATHS.some(p => fullPath.startsWith(p));
      const isGet  = req.method === 'GET';
      if (!isOpen && !isGet) {
        return res.status(403).json({
          error: 'Your account is pending admin verification. You cannot perform this action until your KYC is approved.',
          kycPending: true
        });
      }
    }

    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}

module.exports = { authenticate, requireAdmin, JWT_SECRET };
