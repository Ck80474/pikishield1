const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://pikishield:PikiShield2024!@pikishield.omvtgvb.mongodb.net/pikishield?appName=pikishield';

// ── Schemas ──────────────────────────────────────────────────────────────────
const userSchema = new mongoose.Schema({
  id:           { type: String, default: () => uuidv4() },
  phone:        { type: String, unique: true, sparse: true },
  email:        { type: String, unique: true, sparse: true },
  nokNumber:    { type: String, unique: true, sparse: true },
  password:     String,
  fullName:     String,
  nationalId:   String,
  role:         { type: String, default: 'rider' },
  agentCode:    String,
  county:       String,
  verified:     { type: Boolean, default: false },
  kycStatus:    { type: String, default: 'pending' },
  suspended:    { type: Boolean, default: false },
  riskTier:     { type: String, default: 'green' },
  riskScore:    { type: Number, default: 100 },
  shieldTokens: { type: Number, default: 0 },
  mustChangePassword: { type: Boolean, default: false },
  profile:      { type: mongoose.Schema.Types.Mixed, default: {} },
  createdAt:    { type: String, default: () => new Date().toISOString() },
}, { strict: false });

const policySchema = new mongoose.Schema({
  id:        { type: String, default: () => uuidv4() },
  userId:    String,
  type:      String,
  status:    { type: String, default: 'active' },
  createdAt: { type: String, default: () => new Date().toISOString() },
}, { strict: false });

const claimSchema = new mongoose.Schema({
  id:        { type: String, default: () => uuidv4() },
  userId:    String,
  policyId:  String,
  type:      String,
  status:    { type: String, default: 'pending' },
  createdAt: { type: String, default: () => new Date().toISOString() },
}, { strict: false });

const tokenSchema = new mongoose.Schema({
  id:        { type: String, default: () => uuidv4() },
  userId:    String,
  action:    String,
  amount:    Number,
  createdAt: { type: String, default: () => new Date().toISOString() },
}, { strict: false });

const transactionSchema = new mongoose.Schema({
  id:        { type: String, default: () => uuidv4() },
  userId:    String,
  amount:    Number,
  status:    String,
  createdAt: { type: String, default: () => new Date().toISOString() },
}, { strict: false });

const notificationSchema = new mongoose.Schema({
  id:        { type: String, default: () => uuidv4() },
  userId:    String,
  message:   String,
  read:      { type: Boolean, default: false },
  createdAt: { type: String, default: () => new Date().toISOString() },
}, { strict: false });

const otpSchema = new mongoose.Schema({
  id:        { type: String, default: () => uuidv4() },
  phone:     String,
  otp:       String,
  expiresAt: String,
  createdAt: { type: String, default: () => new Date().toISOString() },
}, { strict: false });

const paymentSchema = new mongoose.Schema({
  id:        { type: String, default: () => uuidv4() },
  userId:    String,
  amount:    Number,
  status:    String,
  createdAt: { type: String, default: () => new Date().toISOString() },
}, { strict: false });

const documentSchema = new mongoose.Schema({
  id:        { type: String, default: () => uuidv4() },
  userId:    String,
  claimId:   String,
  type:      String,
  url:       String,
  createdAt: { type: String, default: () => new Date().toISOString() },
}, { strict: false });

// ── Models ───────────────────────────────────────────────────────────────────
const User         = mongoose.model('User',         userSchema);
const Policy       = mongoose.model('Policy',       policySchema);
const Claim        = mongoose.model('Claim',        claimSchema);
const Token        = mongoose.model('Token',        tokenSchema);
const Transaction  = mongoose.model('Transaction',  transactionSchema);
const Notification = mongoose.model('Notification', notificationSchema);
const Otp          = mongoose.model('Otp',          otpSchema);
const Payment      = mongoose.model('Payment',      paymentSchema);
const Document     = mongoose.model('Document',     documentSchema);

// ── In-memory db object (arrays backed by MongoDB) ───────────────────────────
// All route files use db.users.push(), db.users.find() etc.
// We wrap MongoDB models to look like arrays.

function makeCollection(Model) {
  return {
    _model: Model,
    _cache: [],
    async _load() {
      this._cache = await Model.find({}).lean();
    },
    get length() { return this._cache.length; },
    find(fn)      { return this._cache.find(fn); },
    findIndex(fn) { return this._cache.findIndex(fn); },
    filter(fn)    { return this._cache.filter(fn); },
    some(fn)      { return this._cache.some(fn); },
    map(fn)       { return this._cache.map(fn); },
    forEach(fn)   { return this._cache.forEach(fn); },
    slice(...args){ return this._cache.slice(...args); },
    sort(fn)      { return [...this._cache].sort(fn); },
    reduce(fn, init) { return this._cache.reduce(fn, init); },
    every(fn)     { return this._cache.every(fn); },
    flatMap(fn)   { return this._cache.flatMap(fn); },
    includes(x)   { return this._cache.includes(x); },
    [Symbol.iterator]() { return this._cache[Symbol.iterator](); },
    async push(item) {
      const doc = new Model(item);
      await doc.save();
      this._cache.push(item);
      return this._cache.length;
    },
    async splice(index, count) {
      const item = this._cache[index];
      if (item) await Model.deleteOne({ id: item.id });
      return this._cache.splice(index, count);
    },
    async updateOne(fn, changes) {
      const idx = this._cache.findIndex(fn);
      if (idx === -1) return false;
      Object.assign(this._cache[idx], changes);
      await Model.updateOne({ id: this._cache[idx].id }, { $set: changes });
      return true;
    },
  };
}

const db = {
  users:         makeCollection(User),
  policies:      makeCollection(Policy),
  claims:        makeCollection(Claim),
  tokens:        makeCollection(Token),
  transactions:  makeCollection(Transaction),
  notifications: makeCollection(Notification),
  otps:          makeCollection(Otp),
  payments:      makeCollection(Payment),
  documents:     makeCollection(Document),
};

// saveDb is a no-op — MongoDB saves automatically
function saveDb() {}

async function seedData() {
  await mongoose.connect(MONGO_URI);
  console.log('[DB] Connected to MongoDB Atlas');

  // Load all collections into memory cache
  await Promise.all(Object.values(db).map(c => c._load()));

  const userCount = db.users.length;
  console.log(`[DB] Loaded: ${userCount} users, ${db.policies.length} policies, ${db.claims.length} claims`);

  // Seed admin only if no users exist
  if (userCount === 0) {
    const pwd = await bcrypt.hash('Admin2024!', 10);
    await db.users.push({
      id: uuidv4(), phone: '+254700000001',
      email: 'admin@pikishield.co.ke',
      password: pwd, fullName: 'PikiShield Admin',
      nationalId: '00000001', role: 'admin',
      verified: true, kycStatus: 'approved', suspended: false,
      riskTier: 'green', riskScore: 100, shieldTokens: 0,
      createdAt: new Date().toISOString(), profile: {}
    });
    console.log('');
    console.log('╔══════════════════════════════════════════════════════╗');
    console.log('║         PikiShield — FIRST RUN SETUP                 ║');
    console.log('║    Phone    : +254700000001                          ║');
    console.log('║    Password : Admin2024!                             ║');
    console.log('╚══════════════════════════════════════════════════════╝');
    console.log('');
  }
}

module.exports = { db, seedData, saveDb };
