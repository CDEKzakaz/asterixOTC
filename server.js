require('dotenv').config();
const express = require('express');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const axios = require('axios');

// ===== CONFIG =====
const BOT_TOKEN = process.env.BOT_TOKEN;
const CRYPTO_PAY_TOKEN = process.env.CRYPTO_PAY_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID;
const PORT = process.env.PORT || 3000;
const WEBAPP_URL = process.env.WEBAPP_URL || 'https://your-app.onrender.com';

if (!BOT_TOKEN || !CRYPTO_PAY_TOKEN) {
  console.error('❌ Missing BOT_TOKEN or CRYPTO_PAY_TOKEN');
  process.exit(1);
}

// ===== DATABASE =====
const db = new sqlite3.Database('./swill.db');

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    telegram_id TEXT UNIQUE,
    username TEXT,
    first_name TEXT,
    last_name TEXT,
    balance REAL DEFAULT 0,
    referrals INTEGER DEFAULT 0,
    earned REAL DEFAULT 0,
    ref_code TEXT UNIQUE,
    referred_by TEXT,
    rating REAL DEFAULT 0,
    total_deals INTEGER DEFAULT 0,
    created_at INTEGER
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS requisites (
    id INTEGER PRIMARY KEY,
    user_id TEXT,
    currency TEXT,
    address TEXT,
    UNIQUE(user_id, currency)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS deals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    creator_id TEXT,
    title TEXT,
    amount REAL,
    currency TEXT,
    status TEXT DEFAULT 'pending',
    description TEXT,
    participant_id TEXT,
    role TEXT DEFAULT 'seller',
    invite_code TEXT,
    is_private INTEGER DEFAULT 0,
    escrow_amount REAL DEFAULT 0,
    dispute_reason TEXT,
    created_at INTEGER,
    completed_at INTEGER
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    deal_id INTEGER,
    user_id TEXT,
    message TEXT,
    created_at INTEGER
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS blacklist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    blocked_id TEXT,
    created_at INTEGER,
    UNIQUE(user_id, blocked_id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    type TEXT,
    amount REAL,
    currency TEXT,
    description TEXT,
    created_at INTEGER
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS ratings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    deal_id INTEGER,
    from_user TEXT,
    to_user TEXT,
    rating INTEGER,
    comment TEXT,
    created_at INTEGER
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_id TEXT UNIQUE,
    user_id TEXT,
    amount REAL,
    currency TEXT,
    status TEXT DEFAULT 'pending',
    created_at INTEGER,
    paid_at INTEGER
  )`);
});

// ===== EXPRESS =====
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ===== TELEGRAM BOT =====
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ===== CRYPTO PAY API =====
const CRYPTO_PAY_URL = 'https://pay.crypt.bot/api';

async function cryptoPayRequest(method, params = {}) {
  try {
    const response = await axios.post(`${CRYPTO_PAY_URL}/${method}`, params, {
      headers: {
        'Crypto-Pay-API-Token': CRYPTO_PAY_TOKEN,
        'Content-Type': 'application/json'
      }
    });
    return response.data;
  } catch (error) {
    console.error('Crypto Pay error:', error.response?.data || error.message);
    throw error;
  }
}

// ===== HELPERS =====
function generateRefCode() {
  return 'REF_' + Math.random().toString(36).substring(2, 8).toUpperCase();
}

function generateInviteCode() {
  return 'INV_' + Math.random().toString(36).substring(2, 10).toUpperCase();
}

function isAdmin(telegramId) {
  return telegramId === ADMIN_ID;
}

// ============================================================
// API ROUTES
// ============================================================

// ----- USER -----
app.get('/api/user/:telegramId', (req, res) => {
  const { telegramId } = req.params;
  db.get(`SELECT * FROM users WHERE telegram_id = ?`, [telegramId], (err, user) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!user) {
      const refCode = generateRefCode();
      db.run(
        `INSERT OR IGNORE INTO users (telegram_id, ref_code, created_at) VALUES (?, ?, ?)`,
        [telegramId, refCode, Date.now()],
        function(err) {
          if (err) return res.status(500).json({ error: err.message });
          db.get(`SELECT * FROM users WHERE telegram_id = ?`, [telegramId], (err, newUser) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ ...newUser, isAdmin: isAdmin(telegramId) });
          });
        }
      );
    } else {
      res.json({ ...user, isAdmin: isAdmin(telegramId) });
    }
  });
});

app.post('/api/user/:telegramId', (req, res) => {
  const { telegramId } = req.params;
  const { username, first_name, last_name } = req.body;
  db.run(`UPDATE users SET username = ?, first_name = ?, last_name = ? WHERE telegram_id = ?`,
    [username, first_name, last_name, telegramId],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      db.get(`SELECT * FROM users WHERE telegram_id = ?`, [telegramId], (err, user) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ ...user, isAdmin: isAdmin(telegramId) });
      });
    }
  );
});

// ----- RATINGS -----
app.post('/api/ratings', (req, res) => {
  const { dealId, fromUser, toUser, rating, comment } = req.body;
  db.run(
    `INSERT INTO ratings (deal_id, from_user, to_user, rating, comment, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [dealId, fromUser, toUser, rating, comment || '', Date.now()],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      
      db.get(
        `SELECT AVG(rating) as avg_rating FROM ratings WHERE to_user = ?`,
        [toUser],
        (err, result) => {
          if (err) return res.status(500).json({ error: err.message });
          db.run(`UPDATE users SET rating = ? WHERE telegram_id = ?`,
            [result.avg_rating || 0, toUser]
          );
        }
      );
      res.json({ success: true });
    }
  );
});

app.get('/api/ratings/:userId', (req, res) => {
  const { userId } = req.params;
  db.all(
    `SELECT * FROM ratings WHERE to_user = ? ORDER BY created_at DESC`,
    [userId],
    (err, ratings) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(ratings);
    }
  );
});

// ----- REQUISITES -----
app.get('/api/requisites/:telegramId', (req, res) => {
  const { telegramId } = req.params;
  db.all(`SELECT * FROM requisites WHERE user_id = ?`, [telegramId], (err, requisites) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(requisites);
  });
});

app.post('/api/requisites', (req, res) => {
  const { userId, currency, address } = req.body;
  if (!userId || !currency || !address) {
    return res.status(400).json({ error: 'Missing fields' });
  }
  db.run(`INSERT OR REPLACE INTO requisites (user_id, currency, address) VALUES (?, ?, ?)`,
    [userId, currency, address],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      db.all(`SELECT * FROM requisites WHERE user_id = ?`, [userId], (err, requisites) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(requisites);
      });
    }
  );
});

app.delete('/api/requisites/:id', (req, res) => {
  const { id } = req.params;
  db.run(`DELETE FROM requisites WHERE id = ?`, [id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// ----- DEALS -----
app.get('/api/deals/:telegramId', (req, res) => {
  const { telegramId } = req.params;
  db.all(
    `SELECT * FROM deals WHERE creator_id = ? OR participant_id = ? ORDER BY created_at DESC`,
    [telegramId, telegramId],
    (err, deals) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(deals);
    }
  );
});

app.get('/api/deals/admin/all', (req, res) => {
  const { adminId } = req.query;
  if (!isAdmin(adminId)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  db.all(
    `SELECT * FROM deals ORDER BY created_at DESC`,
    [],
    (err, deals) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(deals);
    }
  );
});

app.post('/api/deals', (req, res) => {
  const { creatorId, title, amount, currency, description, role } = req.body;
  if (!creatorId || !title || !amount || !currency) {
    return res.status(400).json({ error: 'Missing fields' });
  }
  const now = Date.now();
  const inviteCode = generateInviteCode();
  db.run(
    `INSERT INTO deals (creator_id, title, amount, currency, description, created_at, status, role, invite_code)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    [creatorId, title, amount, currency, description || '', now, role || 'seller', inviteCode],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      db.get(`SELECT * FROM deals WHERE id = ?`, [this.lastID], (err, deal) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(deal);
      });
    }
  );
});

app.post('/api/deals/private', (req, res) => {
  const { creatorId, participantId, title, amount, currency, description, role } = req.body;
  if (!creatorId || !participantId || !title || !amount) {
    return res.status(400).json({ error: 'Missing fields' });
  }
  const inviteCode = generateInviteCode();
  const now = Date.now();
  db.run(
    `INSERT INTO deals (creator_id, participant_id, title, amount, currency, description, invite_code, is_private, role, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 'pending', ?)`,
    [creatorId, participantId, title, amount, currency, description || '', inviteCode, role || 'seller', now],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      db.get(`SELECT * FROM deals WHERE id = ?`, [this.lastID], (err, deal) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(deal);
      });
    }
  );
});

app.post('/api/deals/:dealId/invite', (req, res) => {
  const { dealId } = req.params;
  const { userId } = req.body;
  const inviteCode = generateInviteCode();
  db.run(
    `UPDATE deals SET invite_code = ? WHERE id = ?`,
    [inviteCode, dealId],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      const link = `${WEBAPP_URL}?invite=${inviteCode}`;
      res.json({ inviteCode, link });
    }
  );
});

app.post('/api/deals/:dealId/accept', (req, res) => {
  const { dealId } = req.params;
  const { participantId } = req.body;
  db.run(`UPDATE deals SET participant_id = ?, status = 'active' WHERE id = ?`,
    [participantId, dealId],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      db.get(`SELECT * FROM deals WHERE id = ?`, [dealId], (err, deal) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(deal);
      });
    }
  );
});

app.post('/api/deals/:dealId/decline', (req, res) => {
  const { dealId } = req.params;
  db.run(`UPDATE deals SET status = 'declined' WHERE id = ?`, [dealId], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    db.get(`SELECT * FROM deals WHERE id = ?`, [dealId], (err, deal) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(deal);
    });
  });
});

// ----- ESCROW -----
app.post('/api/deals/:dealId/escrow', (req, res) => {
  const { dealId } = req.params;
  const { userId } = req.body;
  
  db.get(`SELECT * FROM deals WHERE id = ?`, [dealId], (err, deal) => {
    if (err) return res.status(500).json({ error: err.message });
    
    db.run(`UPDATE users SET balance = balance - ? WHERE telegram_id = ?`,
      [deal.amount, deal.creator_id],
      (err) => {
        if (err) return res.status(500).json({ error: err.message });
        
        db.run(`UPDATE deals SET status = 'escrow', participant_id = ?, escrow_amount = ? WHERE id = ?`,
          [userId, deal.amount, dealId],
          (err) => {
            if (err) return res.status(500).json({ error: err.message });
            db.get(`SELECT * FROM deals WHERE id = ?`, [dealId], (err, updated) => {
              if (err) return res.status(500).json({ error: err.message });
              res.json(updated);
            });
          }
        );
      }
    );
  });
});

app.post('/api/deals/:dealId/release', (req, res) => {
  const { dealId } = req.params;
  const { adminId } = req.body;
  
  if (!isAdmin(adminId)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  
  db.get(`SELECT * FROM deals WHERE id = ?`, [dealId], (err, deal) => {
    if (err) return res.status(500).json({ error: err.message });
    
    db.run(`UPDATE users SET balance = balance + ? WHERE telegram_id = ?`,
      [deal.escrow_amount, deal.participant_id],
      (err) => {
        if (err) return res.status(500).json({ error: err.message });
        
        db.run(`UPDATE deals SET status = 'completed', completed_at = ? WHERE id = ?`,
          [Date.now(), dealId],
          (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
          }
        );
      }
    );
  });
});

// ----- DISPUTE -----
app.post('/api/deals/:dealId/dispute', (req, res) => {
  const { dealId } = req.params;
  const { userId, reason } = req.body;
  
  db.run(`UPDATE deals SET status = 'dispute', dispute_reason = ? WHERE id = ?`,
    [reason || 'No reason provided', dealId],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      db.get(`SELECT * FROM deals WHERE id = ?`, [dealId], (err, deal) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(deal);
      });
    }
  );
});

app.get('/api/deals/disputes/:adminId', (req, res) => {
  const { adminId } = req.params;
  if (!isAdmin(adminId)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  db.all(
    `SELECT * FROM deals WHERE status = 'dispute' ORDER BY created_at DESC`,
    [],
    (err, deals) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(deals);
    }
  );
});

app.post('/api/deals/:dealId/admin/complete', (req, res) => {
  const { dealId } = req.params;
  const { adminId } = req.body;
  
  if (!isAdmin(adminId)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  
  db.run(`UPDATE deals SET status = 'completed', completed_at = ? WHERE id = ?`,
    [Date.now(), dealId],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      
      db.get(`SELECT * FROM deals WHERE id = ?`, [dealId], (err, deal) => {
        if (err) return res.status(500).json({ error: err.message });
        if (deal.escrow_amount > 0 && deal.participant_id) {
          db.run(`UPDATE users SET balance = balance + ? WHERE telegram_id = ?`,
            [deal.escrow_amount, deal.participant_id]
          );
        }
        res.json({ success: true });
      });
    }
  );
});

app.post('/api/deals/:dealId/admin/cancel', (req, res) => {
  const { dealId } = req.params;
  const { adminId } = req.body;
  
  if (!isAdmin(adminId)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  
  db.get(`SELECT * FROM deals WHERE id = ?`, [dealId], (err, deal) => {
    if (err) return res.status(500).json({ error: err.message });
    
    if (deal.escrow_amount > 0) {
      db.run(`UPDATE users SET balance = balance + ? WHERE telegram_id = ?`,
        [deal.escrow_amount, deal.creator_id]
      );
    }
    
    db.run(`UPDATE deals SET status = 'cancelled' WHERE id = ?`, [dealId], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    });
  });
});

app.post('/api/deals/:dealId/complete', (req, res) => {
  const { dealId } = req.params;
  const now = Date.now();
  db.run(`UPDATE deals SET status = 'completed', completed_at = ? WHERE id = ?`,
    [now, dealId],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      db.get(`SELECT * FROM deals WHERE id = ?`, [dealId], (err, deal) => {
        if (err) return res.status(500).json({ error: err.message });
        const commission = deal.amount * 0.01;
        db.run(`UPDATE users SET balance = balance + ? WHERE telegram_id = ?`,
          [deal.amount - commission, deal.creator_id],
          (err) => {
            if (err) return res.status(500).json({ error: err.message });
            if (deal.participant_id) {
              db.get(`SELECT referred_by FROM users WHERE telegram_id = ?`,
                [deal.participant_id],
                (err, user) => {
                  if (!err && user && user.referred_by) {
                    const refCommission = commission * 0.25;
                    db.run(`UPDATE users SET earned = earned + ? WHERE telegram_id = ?`,
                      [refCommission, user.referred_by]
                    );
                  }
                }
              );
            }
            db.run(`UPDATE users SET total_deals = total_deals + 1 WHERE telegram_id = ?`,
              [deal.creator_id]
            );
            if (deal.participant_id) {
              db.run(`UPDATE users SET total_deals = total_deals + 1 WHERE telegram_id = ?`,
                [deal.participant_id]
              );
            }
            db.get(`SELECT * FROM deals WHERE id = ?`, [dealId], (err, updated) => {
              if (err) return res.status(500).json({ error: err.message });
              res.json(updated);
            });
          }
        );
      });
    }
  );
});

app.post('/api/deals/:dealId/cancel', (req, res) => {
  const { dealId } = req.params;
  db.run(`UPDATE deals SET status = 'cancelled' WHERE id = ?`, [dealId], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    db.get(`SELECT * FROM deals WHERE id = ?`, [dealId], (err, deal) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(deal);
    });
  });
});

// ----- CHAT -----
app.get('/api/chat/:dealId', (req, res) => {
  const { dealId } = req.params;
  db.all(
    `SELECT * FROM chat_messages WHERE deal_id = ? ORDER BY created_at ASC`,
    [dealId],
    (err, messages) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(messages);
    }
  );
});

app.post('/api/chat', (req, res) => {
  const { dealId, userId, message } = req.body;
  if (!dealId || !userId || !message) {
    return res.status(400).json({ error: 'Missing fields' });
  }
  db.run(
    `INSERT INTO chat_messages (deal_id, user_id, message, created_at) VALUES (?, ?, ?, ?)`,
    [dealId, userId, message, Date.now()],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      db.get(`SELECT * FROM chat_messages WHERE id = ?`, [this.lastID], (err, msg) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(msg);
      });
    }
  );
});

// ----- BLACKLIST -----
app.get('/api/blacklist/:userId', (req, res) => {
  const { userId } = req.params;
  db.all(`SELECT * FROM blacklist WHERE user_id = ?`, [userId], (err, list) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(list);
  });
});

app.post('/api/blacklist', (req, res) => {
  const { userId, blockedId } = req.body;
  if (!userId || !blockedId) {
    return res.status(400).json({ error: 'Missing fields' });
  }
  db.run(
    `INSERT OR REPLACE INTO blacklist (user_id, blocked_id, created_at) VALUES (?, ?, ?)`,
    [userId, blockedId, Date.now()],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    }
  );
});

app.delete('/api/blacklist', (req, res) => {
  const { userId, blockedId } = req.body;
  db.run(
    `DELETE FROM blacklist WHERE user_id = ? AND blocked_id = ?`,
    [userId, blockedId],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    }
  );
});

// ----- TRANSACTIONS -----
app.get('/api/transactions/:telegramId', (req, res) => {
  const { telegramId } = req.params;
  db.all(
    `SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`,
    [telegramId],
    (err, transactions) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(transactions);
    }
  );
});

app.post('/api/transactions', (req, res) => {
  const { userId, type, amount, currency, description } = req.body;
  db.run(
    `INSERT INTO transactions (user_id, type, amount, currency, description, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [userId, type, amount, currency, description || '', Date.now()],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      db.get(`SELECT * FROM transactions WHERE id = ?`, [this.lastID], (err, tx) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(tx);
      });
    }
  );
});

// ----- REFERRAL -----
app.get('/api/referrals/:telegramId', (req, res) => {
  const { telegramId } = req.params;
  db.get(`SELECT referrals, earned FROM users WHERE telegram_id = ?`, [telegramId], (err, stats) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(stats || { referrals: 0, earned: 0 });
  });
});

app.post('/api/referral/apply', (req, res) => {
  const { userId, refCode } = req.body;
  db.get(`SELECT telegram_id FROM users WHERE ref_code = ?`, [refCode], (err, referrer) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!referrer) return res.status(404).json({ error: 'Invalid referral code' });
    if (referrer.telegram_id === userId) {
      return res.status(400).json({ error: 'Cannot refer yourself' });
    }
    db.run(`UPDATE users SET referred_by = ?, referrals = referrals + 1 WHERE telegram_id = ?`,
      [referrer.telegram_id, userId],
      function(err) {
        if (err) return res.status(500).json({ error: err.message });
        db.run(`UPDATE users SET referrals = referrals + 1 WHERE telegram_id = ?`,
          [referrer.telegram_id]
        );
        res.json({ success: true });
      }
    );
  });
});

// ----- INVOICES (CRYPTO PAY) -----
app.post('/api/invoice/create', async (req, res) => {
  const { userId, amount, currency } = req.body;
  
  if (!userId || !amount || !currency) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  if (amount < 1) {
    return res.status(400).json({ error: 'Minimum deposit is $1' });
  }

  try {
    const result = await cryptoPayRequest('createInvoice', {
      amount: amount,
      currency_code: currency,
      description: `SWILL OTC Deposit (${userId})`,
      paid_btn_name: 'openBot',
      paid_btn_url: WEBAPP_URL
    });

    if (result.ok) {
      const invoice = result.result;
      
      db.run(
        `INSERT INTO invoices (invoice_id, user_id, amount, currency, status, created_at)
         VALUES (?, ?, ?, ?, 'pending', ?)`,
        [invoice.invoice_id, userId, amount, currency, Date.now()],
        function(err) {
          if (err) return res.status(500).json({ error: err.message });
          res.json({
            invoice_id: invoice.invoice_id,
            url: invoice.pay_url,
            amount: invoice.amount,
            currency: invoice.currency_code,
            status: 'pending'
          });
        }
      );
    } else {
      res.status(500).json({ error: 'Failed to create invoice' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/invoice/status/:invoiceId', (req, res) => {
  const { invoiceId } = req.params;
  db.get(
    `SELECT * FROM invoices WHERE invoice_id = ?`,
    [invoiceId],
    (err, invoice) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
      res.json({ status: invoice.status });
    }
  );
});

// ----- CRYPTO PAY WEBHOOK -----
app.post('/webhook/cryptopay', (req, res) => {
  const { invoice_id, status, amount, currency_code } = req.body;
  
  console.log('Crypto Pay webhook:', req.body);
  
  if (status === 'paid') {
    db.get(`SELECT * FROM invoices WHERE invoice_id = ?`, [invoice_id], (err, invoice) => {
      if (err || !invoice) {
        return res.status(404).json({ error: 'Invoice not found' });
      }
      
      if (invoice.status === 'paid') {
        return res.json({ success: true });
      }
      
      db.run(`UPDATE invoices SET status = 'paid', paid_at = ? WHERE invoice_id = ?`,
        [Date.now(), invoice_id]
      );
      
      db.run(`UPDATE users SET balance = balance + ? WHERE telegram_id = ?`,
        [parseFloat(amount), invoice.user_id]
      );
      
      db.run(
        `INSERT INTO transactions (user_id, type, amount, currency, description, created_at)
         VALUES (?, 'deposit', ?, ?, 'Deposit via Crypto Pay', ?)`,
        [invoice.user_id, parseFloat(amount), currency_code || 'USDT', Date.now()]
      );
      
      bot.sendMessage(invoice.user_id, 
        `✅ *Deposit Successful!*\n\n` +
        `Amount: ${amount} ${currency_code || 'USDT'}\n` +
        `New Balance: ${parseFloat(amount)} USDT\n\n` +
        `You can continue trading! 🚀`,
        { parse_mode: 'Markdown' }
      );
    });
  }
  
  res.json({ success: true });
});

// ============================================================
// BOT COMMANDS — ИСПРАВЛЕННЫЙ!
// ============================================================

bot.onText(/\/start(?:\s+(.+))?/, (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();
  const firstName = msg.from.first_name || 'Trader';

  db.get(`SELECT * FROM users WHERE telegram_id = ?`, [userId], (err, user) => {
    if (err) {
      console.error('Database error:', err);
      return;
    }
    
    if (!user) {
      const refCode = generateRefCode();
      db.run(
        `INSERT OR IGNORE INTO users (telegram_id, username, first_name, last_name, ref_code, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [userId, msg.from.username || '', firstName, msg.from.last_name || '', refCode, Date.now()],
        function(err) {
          if (err) {
            console.error('Insert error:', err);
          }
        }
      );
    } else {
      db.run(
        `UPDATE users SET username = ?, first_name = ?, last_name = ? WHERE telegram_id = ?`,
        [msg.from.username || '', firstName, msg.from.last_name || '', userId]
      );
    }
  });

  const args = match[1];
  if (args && args.startsWith('deal_')) {
    const inviteCode = args.replace('deal_', '');
    bot.sendMessage(chatId,
      `🔗 *Deal Invite!*\n\n` +
      `You've been invited to a deal.\n` +
      `Click below to open the app and respond.`,
      { parse_mode: 'Markdown', reply_markup: {
        inline_keyboard: [[
          { text: 'Open Deal', web_app: { url: `${WEBAPP_URL}?invite=${inviteCode}` } }
        ]]
      }}
    );
    return;
  }

  bot.sendMessage(chatId,
    `⚡ *SWILL OTC Platform*\n\nWelcome ${firstName}!\n\n` +
    `• Create deals\n` +
    `• Invite partners\n` +
    `• Earn commissions\n` +
    `• Secure escrow`,
    { parse_mode: 'Markdown', reply_markup: {
      inline_keyboard: [
        [{ text: 'Open App', web_app: { url: WEBAPP_URL } }],
        [{ text: 'My Referral Link', callback_data: 'my_ref' }]
      ]
    }}
  );
});

bot.on('callback_query', (query) => {
  const chatId = query.message.chat.id;
  const userId = query.from.id.toString();

  if (query.data === 'my_ref') {
    db.get(`SELECT ref_code FROM users WHERE telegram_id = ?`, [userId], (err, user) => {
      if (err || !user) {
        bot.sendMessage(chatId, '❌ Error getting referral code');
        return;
      }
      const refLink = `https://t.me/${bot.getMe().then(m => m.username)}?start=${user.ref_code}`;
      bot.sendMessage(chatId,
        `🔗 *Your Referral Link*\n\n${refLink}\n\nShare this link and earn 25% commission!`,
        { parse_mode: 'Markdown' }
      );
    });
  }
  bot.answerCallbackQuery(query.id);
});

// ============================================================
// SERVE
// ============================================================

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ============================================================
// ЗАПУСК
// ============================================================

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`🌐 WebApp URL: ${WEBAPP_URL}`);
  console.log(`👑 Admin ID: ${ADMIN_ID}`);
  console.log(`💰 Crypto Pay: ${CRYPTO_PAY_TOKEN ? '✅ Connected' : '❌ Not configured'}`);
});
