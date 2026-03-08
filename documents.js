const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { db, saveDb } = require('./db');
const { authenticate } = require('./auth_middleware');

const UPLOAD_DIR = path.join(__dirname, '../../uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  ['.pdf','.jpg','.jpeg','.png','.webp'].includes(ext) ? cb(null, true) : cb(new Error(`"${ext}" not allowed`), false);
};

const authStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(UPLOAD_DIR, req.user.id);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname).toLowerCase()}`)
});
const upload = multer({ storage: authStorage, fileFilter, limits: { fileSize: 10*1024*1024 } });

const tempStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(UPLOAD_DIR, 'temp', req.body.tempUploadId || 'unknown');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname).toLowerCase()}`)
});
const tempUpload = multer({ storage: tempStorage, fileFilter, limits: { fileSize: 10*1024*1024 } });

if (!db.documents) db.documents = [];

const DOC_LABELS = {
  // ── Bail claim docs ────────────────────────────────────────────────
  police_abstract:    { label:'Police Abstract / OB Number',          icon:'🚔', required:true,  types:['bail','bail_income'] },
  court_charge_sheet: { label:'Court Charge Sheet (if charged)',       icon:'⚖️', required:false, types:['bail','bail_income'] },
  national_id:        { label:'National ID Copy',                     icon:'🪪', required:true,  types:['bail','bail_income','income','funeral','kyc'] },

  // ── Stipend (income) claim docs ────────────────────────────────────
  doctor_note:        { label:"Doctor's Note (with Doctor Name & Hospital)", icon:'🩺', required:true,  types:['income','bail_income'] },
  xray_scan:          { label:'X-Ray / Scan / Lab Result',            icon:'🏥', required:false, types:['income','bail_income'] },
  hospital_receipt:   { label:'Hospital Receipt',                     icon:'🧾', required:false, types:['income','bail_income'] },

  // ── Funeral claim docs ─────────────────────────────────────────────
  death_certificate:  { label:'Death Certificate (Official)',          icon:'📜', required:true,  types:['funeral'] },
  burial_permit:      { label:'Burial Permit',                        icon:'📋', required:true,  types:['funeral'] },
  deceased_id:        { label:"Deceased's National ID Copy",          icon:'👤', required:true,  types:['funeral'] },

  // ── KYC docs (registration) ───────────────────────────────────────
  riders_license:     { label:"Rider's License",                      icon:'🏍️', required:true,  types:['kyc'] },
  insurance_cert:     { label:'Bike Insurance Certificate',           icon:'📄', required:true,  types:['kyc'] },

  // ── Optional catch-all ────────────────────────────────────────────
  other:              { label:'Other Supporting Document',            icon:'📎', required:false, types:['bail','bail_income','funeral','income','kyc'] },
};

router.get('/types', authenticate, async (req, res) => {
  const { claimType } = req.query;
  if (!claimType) return res.json(DOC_LABELS);
  const filtered = Object.entries(DOC_LABELS)
    .filter(([,v]) => v.types.includes(claimType))
    .reduce((acc,[k,v]) => ({ ...acc,[k]:v }), {});
  res.json(filtered);
});

router.get('/user/:userId', authenticate, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.id !== req.params.userId)
    return res.status(403).json({ error:'Forbidden' });
  res.json(db.documents.filter(d => d.userId === req.params.userId));
});

router.get('/claim/:claimId', authenticate, async (req, res) => {
  const claim = db.claims.find(c => c.id === req.params.claimId);
  if (!claim) return res.status(404).json({ error:'Claim not found' });
  if (req.user.role !== 'admin' && claim.userId !== req.user.id)
    return res.status(403).json({ error:'Forbidden' });
  res.json(db.documents.filter(d => d.claimId === req.params.claimId));
});

// PUBLIC — no auth, used during registration before user exists
router.post('/upload-kyc', tempUpload.array('files', 5), async (req, res) => {
  try {
    const { docType, tempUploadId } = req.body;
    if (!req.files?.length) return res.status(400).json({ error:'No files uploaded' });
    if (!DOC_LABELS[docType]) return res.status(400).json({ error:'Invalid document type: '+docType });
    if (!tempUploadId) return res.status(400).json({ error:'tempUploadId required' });
    const saved = [];
    for (const file of req.files) {
      const doc = { id:uuidv4(), userId:null, claimId:null, tempUploadId, docType,
        docLabel:DOC_LABELS[docType].label, originalName:file.originalname,
        storedName:file.filename, mimeType:file.mimetype, size:file.size,
        path:file.path, uploadedAt:new Date().toISOString(), verified:false, isKyc:true };
      await db.documents.push(doc);
      saved.push({ id:doc.id, docType, docLabel:doc.docLabel, originalName:file.originalname, mimeType:file.mimetype, size:file.size });
    }
    res.status(201).json({ documents:saved, message:`${saved.length} KYC document(s) staged` });
  } catch(err) { res.status(500).json({ error:err.message||'Upload failed' }); }
});

router.post('/attach-kyc', authenticate, async (req, res) => {
  const { tempUploadId, userId } = req.body;
  if (!tempUploadId) return res.status(400).json({ error:'tempUploadId required' });
  // Admins can attach docs to another user by passing userId; else attach to self
  const targetUserId = (req.user.role === 'admin' && userId) ? userId : req.user.id;
  const docs = db.documents.filter(d => d.tempUploadId === tempUploadId && d.userId === null);
  docs.forEach(d => { d.userId = targetUserId; });
  res.json({ attached:docs.length });
});

router.post('/upload', authenticate, upload.array('files', 5), async (req, res) => {
  try {
    const { claimId, docType, tempUploadId } = req.body;
    if (!req.files?.length) return res.status(400).json({ error:'No files uploaded' });
    if (!DOC_LABELS[docType]) return res.status(400).json({ error:'Invalid document type' });
    if (claimId) {
      const claim = db.claims.find(c => c.id === claimId);
      if (!claim) return res.status(404).json({ error:'Claim not found' });
      if (req.user.role !== 'admin' && claim.userId !== req.user.id)
        return res.status(403).json({ error:'Forbidden' });
    }
    const saved = req.files.map(file => {
      const doc = { id:uuidv4(), userId:req.user.id, claimId:claimId||null,
        tempUploadId:tempUploadId||null, docType, docLabel:DOC_LABELS[docType].label,
        originalName:file.originalname, storedName:file.filename,
        mimeType:file.mimetype, size:file.size, path:file.path,
        uploadedAt:new Date().toISOString(), verified:false };
      db.documents.push(doc);
      if (claimId) {
        const cl = db.claims.find(c => c.id === claimId);
        if (cl) { if (!cl.documents) cl.documents=[]; cl.documents.push({ id:doc.id, docType, docLabel:doc.docLabel, originalName:file.originalname }); }
      }
      return { id:doc.id, docType, docLabel:doc.docLabel, originalName:file.originalname, mimeType:file.mimetype, size:file.size, uploadedAt:doc.uploadedAt };
    });
    res.status(201).json({ documents:saved, message:`${saved.length} document(s) uploaded` });
  } catch(err) { res.status(500).json({ error:err.message||'Upload failed' }); }
});

router.post('/attach', authenticate, async (req, res) => {
  const { claimId, tempUploadId } = req.body;
  if (!claimId||!tempUploadId) return res.status(400).json({ error:'claimId and tempUploadId required' });
  const claim = db.claims.find(c => c.id === claimId && c.userId === req.user.id);
  if (!claim) return res.status(404).json({ error:'Claim not found' });
  const docs = db.documents.filter(d => d.tempUploadId === tempUploadId && d.userId === req.user.id);
  docs.forEach(d => {
    d.claimId = claimId;
    if (!claim.documents) claim.documents = [];
    claim.documents.push({ id:d.id, docType:d.docType, docLabel:d.docLabel, originalName:d.originalName });
  });
  res.json({ attached:docs.length });
});

// Helper — allows ?token= in query for direct browser links (preview/download)
async function authenticateQuery(req, res, next) {
  // Prefer Authorization header, fall back to ?token= query param
  const queryToken = req.query.token;
  if (queryToken && !req.headers.authorization) {
    req.headers.authorization = `Bearer ${queryToken}`;
  }
  return next();
}

router.get('/:id/preview', authenticateQuery, authenticate, async (req, res) => {
  const doc = db.documents.find(d => d.id === req.params.id);
  if (!doc) return res.status(404).json({ error:'Not found' });
  if (req.user.role !== 'admin' && doc.userId !== req.user.id) return res.status(403).json({ error:'Forbidden' });
  if (!doc.path||!fs.existsSync(doc.path)) return res.status(404).json({ error:'File not on disk' });
  res.setHeader('Content-Type', doc.mimeType);
  res.setHeader('Content-Disposition', `inline; filename="${doc.originalName}"`);
  fs.createReadStream(doc.path).pipe(res);
});

router.get('/:id/download', authenticateQuery, authenticate, async (req, res) => {
  const doc = db.documents.find(d => d.id === req.params.id);
  if (!doc) return res.status(404).json({ error:'Not found' });
  if (req.user.role !== 'admin' && doc.userId !== req.user.id) return res.status(403).json({ error:'Forbidden' });
  if (!doc.path||!fs.existsSync(doc.path)) return res.status(404).json({ error:'File not on disk' });
  res.setHeader('Content-Disposition', `attachment; filename="${doc.originalName}"`);
  res.setHeader('Content-Type', doc.mimeType);
  fs.createReadStream(doc.path).pipe(res);
});

router.delete('/:id', authenticate, async (req, res) => {
  const idx = db.documents.findIndex(d => d.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error:'Not found' });
  const doc = db.documents[idx];
  if (req.user.role !== 'admin' && doc.userId !== req.user.id) return res.status(403).json({ error:'Forbidden' });
  if (doc.path && fs.existsSync(doc.path)) { try { fs.unlinkSync(doc.path); } catch {} }
  await db.documents.splice(idx, 1);
  if (doc.claimId) {
    const cl = db.claims.find(c => c.id === doc.claimId);
    if (cl?.documents) cl.documents = cl.documents.filter(d => d.id !== doc.id);
  }
  res.json({ message:'Deleted' });
});

router.patch('/:id/verify', authenticate, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error:'Admin only' });
  const doc = db.documents.find(d => d.id === req.params.id);
  if (!doc) return res.status(404).json({ error:'Not found' });
  doc.verified = true;
  doc.verifiedAt = new Date().toISOString();
  doc.verifiedBy = req.user.fullName;
  res.json(doc);
});

router.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error:'Max 10MB per file' });
  if (err.message) return res.status(400).json({ error:err.message });
  next(err);
});

module.exports = router;
