require('dotenv').config();
const express = require('express');
const path    = require('path');
const { seedData } = require('./db');

const app  = express();
const PORT = process.env.PORT || 5000;

// CORS — must be first middleware, before everything
app.use(function(req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const { router: authRouter } = require('./auth');
app.use('/api/auth',      authRouter);
app.use('/api/policies',  require('./policies'));
app.use('/api/claims',    require('./claims'));
app.use('/api/users',     require('./users'));
app.use('/api/documents', require('./documents'));
app.use('/api/payments',  require('./payments'));

app.get('/api/health', (req, res) => res.json({ status: 'ok', version: '6.0.0' }));

app.use('/api', (req, res) => res.status(404).json({ error: 'API route not found' }));

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

async function start() {
  await seedData();
  app.listen(PORT, () => {
    console.log('PikiShield v6 running on port ' + PORT);
  });
}
start();
