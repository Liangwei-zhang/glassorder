const path = require('path');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const { poCodeKey } = require('./services/poCode');

const dbPath = process.env.DB_PATH || path.join(__dirname, 'glass.db');
const uploadsBase = process.env.UPLOADS_DIR
  ? path.resolve(process.env.UPLOADS_DIR)
  : path.join(__dirname, 'uploads');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function columnExists(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
}

function indexExists(name) {
  return Boolean(db.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?
  `).get(name));
}

function tableSql(name) {
  const row = db.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(name);
  return row ? String(row.sql || '') : '';
}

function recreatePiecesTableWithPolishStage() {
  const sql = tableSql('pieces');
  if (!sql || sql.includes("'polish'")) return;

  db.exec(`
    PRAGMA foreign_keys = OFF;

    CREATE TABLE pieces_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      piece_no INTEGER NOT NULL,
      stage TEXT NOT NULL DEFAULT 'cut' CHECK (stage IN ('cut', 'edge', 'tempered', 'polish', 'finished')),
      hold INTEGER NOT NULL DEFAULT 0,
      rework INTEGER NOT NULL DEFAULT 0,
      broken INTEGER NOT NULL DEFAULT 0,
      size TEXT,
      type TEXT,
      thickness TEXT,
      weight TEXT,
      piece_note TEXT,
      drawing_path TEXT,
      process_config TEXT,
      completed_steps TEXT,
      picked_up_at TEXT,
      pickup_batch_id INTEGER,
      UNIQUE(order_id, piece_no)
    );

    INSERT INTO pieces_new (
      id, order_id, piece_no, stage, hold, rework, broken,
      size, type, thickness, weight, piece_note, drawing_path,
      process_config, completed_steps, picked_up_at, pickup_batch_id
    )
    SELECT
      id, order_id, piece_no, stage, hold, rework, broken,
      size, type, thickness, weight, piece_note, drawing_path,
      process_config, completed_steps, picked_up_at, pickup_batch_id
    FROM pieces;

    DROP TABLE pieces;
    ALTER TABLE pieces_new RENAME TO pieces;

    CREATE INDEX IF NOT EXISTS idx_pieces_order ON pieces(order_id);
    CREATE INDEX IF NOT EXISTS idx_pieces_stage ON pieces(stage);
    CREATE INDEX IF NOT EXISTS idx_pieces_pickup_batch ON pieces(pickup_batch_id);
    CREATE INDEX IF NOT EXISTS idx_pieces_picked_up_at ON pieces(picked_up_at);

    PRAGMA foreign_keys = ON;
  `);
}

function migrateDb() {
  const migrations = [
    {
      name: 'phase3_order_file_hash',
      run() {
        if (!columnExists('orders', 'source_file_hash')) {
          db.exec('ALTER TABLE orders ADD COLUMN source_file_hash TEXT');
        }
        if (!columnExists('orders', 'original_filename')) {
          db.exec('ALTER TABLE orders ADD COLUMN original_filename TEXT');
        }
        if (!indexExists('idx_orders_source_file_hash_unique')) {
          db.exec(`
            CREATE UNIQUE INDEX idx_orders_source_file_hash_unique
            ON orders(source_file_hash)
            WHERE source_file_hash IS NOT NULL
          `);
        }
      },
    },
    {
      name: 'phase3_piece_process_config',
      run() {
        if (!columnExists('pieces', 'process_config')) {
          db.exec('ALTER TABLE pieces ADD COLUMN process_config TEXT');
        }
        if (!columnExists('pieces', 'completed_steps')) {
          db.exec('ALTER TABLE pieces ADD COLUMN completed_steps TEXT');
        }
      },
    },
    {
      name: 'phase11_order_archive',
      run() {
        if (!columnExists('orders', 'archived_at')) {
          db.exec('ALTER TABLE orders ADD COLUMN archived_at TEXT');
        }
        if (!columnExists('orders', 'archived_by')) {
          db.exec('ALTER TABLE orders ADD COLUMN archived_by INTEGER');
        }
        if (!indexExists('idx_orders_archived_at')) {
          db.exec('CREATE INDEX idx_orders_archived_at ON orders(archived_at)');
        }
        if (!indexExists('idx_orders_number_archived')) {
          db.exec('CREATE INDEX idx_orders_number_archived ON orders(order_number, archived_at)');
        }
      },
    },
    {
      name: 'phase13_piece_pickup_batches',
      run() {
        if (!columnExists('pieces', 'picked_up_at')) {
          db.exec('ALTER TABLE pieces ADD COLUMN picked_up_at TEXT');
        }
        if (!columnExists('pieces', 'pickup_batch_id')) {
          db.exec('ALTER TABLE pieces ADD COLUMN pickup_batch_id INTEGER');
        }
        db.exec(`
          CREATE TABLE IF NOT EXISTS pickup_batches (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            batch_number TEXT NOT NULL UNIQUE,
            customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
            signer_name TEXT NOT NULL,
            signer_phone TEXT,
            signature_path TEXT NOT NULL DEFAULT '',
            slip_pdf_path TEXT NOT NULL,
            picked_at TEXT NOT NULL DEFAULT (datetime('now')),
            picked_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
            reverted_at TEXT,
            reverted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
            revert_reason TEXT
          );

          CREATE TABLE IF NOT EXISTS pickup_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            batch_id INTEGER NOT NULL REFERENCES pickup_batches(id) ON DELETE CASCADE,
            order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
            piece_id INTEGER NOT NULL REFERENCES pieces(id) ON DELETE CASCADE,
            picked_at TEXT NOT NULL DEFAULT (datetime('now')),
            reverted_at TEXT,
            reverted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
            revert_reason TEXT,
            UNIQUE(batch_id, piece_id)
          );
        `);
        if (!indexExists('idx_pieces_pickup_batch')) {
          db.exec('CREATE INDEX idx_pieces_pickup_batch ON pieces(pickup_batch_id)');
        }
        if (!indexExists('idx_pieces_picked_up_at')) {
          db.exec('CREATE INDEX idx_pieces_picked_up_at ON pieces(picked_up_at)');
        }
        if (!indexExists('idx_pickup_batches_customer')) {
          db.exec('CREATE INDEX idx_pickup_batches_customer ON pickup_batches(customer_id, picked_at)');
        }
        if (!indexExists('idx_pickup_items_batch')) {
          db.exec('CREATE INDEX idx_pickup_items_batch ON pickup_items(batch_id)');
        }
        if (!indexExists('idx_pickup_items_piece')) {
          db.exec('CREATE INDEX idx_pickup_items_piece ON pickup_items(piece_id)');
        }
        if (!indexExists('idx_pickup_items_order')) {
          db.exec('CREATE INDEX idx_pickup_items_order ON pickup_items(order_id)');
        }
      },
    },
    {
      name: 'phase31_pickup_batch_counters',
      run() {
        db.exec(`
          CREATE TABLE IF NOT EXISTS pickup_batch_counters (
            prefix TEXT PRIMARY KEY,
            next_seq INTEGER NOT NULL
          )
        `);
      },
    },
    {
      name: 'phase14_polish_stage',
      run() {
        recreatePiecesTableWithPolishStage();
      },
    },
    {
      name: 'phase14_customer_email_cc',
      run() {
        if (!columnExists('customers', 'email_cc')) {
          db.exec('ALTER TABLE customers ADD COLUMN email_cc TEXT');
        }
      },
    },
    {
      name: 'phase50_piece_tag',
      run() {
        if (!columnExists('pieces', 'tag')) {
          db.exec('ALTER TABLE pieces ADD COLUMN tag TEXT');
        }
      },
    },
    {
      name: 'phase39_order_number_po_key',
      run() {
        if (!columnExists('orders', 'order_number_key')) {
          db.exec('ALTER TABLE orders ADD COLUMN order_number_key TEXT');
        }
        const rows = db.prepare('SELECT id, order_number FROM orders ORDER BY id').all();
        const seen = new Set();
        const update = db.prepare('UPDATE orders SET order_number_key = ? WHERE id = ?');
        for (const row of rows) {
          const baseKey = poCodeKey(row.order_number) || `order${row.id}`;
          const key = seen.has(baseKey) ? `${baseKey}${row.id}` : baseKey;
          seen.add(key);
          update.run(key, row.id);
        }
        if (!indexExists('idx_orders_order_number_key_unique')) {
          db.exec(`
            CREATE UNIQUE INDEX idx_orders_order_number_key_unique
            ON orders(order_number_key)
            WHERE order_number_key IS NOT NULL AND order_number_key <> ''
          `);
        }
      },
    },
    {
      name: 'phase44_pickup_qr_sign_requests',
      run() {
        db.exec(`
          CREATE TABLE IF NOT EXISTS pickup_sign_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            token_hash TEXT NOT NULL UNIQUE,
            customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
            piece_ids TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'signed', 'cancelled', 'expired')),
            signer_name TEXT,
            signer_phone TEXT,
            signature_path TEXT NOT NULL DEFAULT '',
            slip_pdf_path TEXT NOT NULL DEFAULT '',
            pickup_batch_id INTEGER REFERENCES pickup_batches(id) ON DELETE SET NULL,
            created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            expires_at TEXT NOT NULL,
            signed_at TEXT,
            cancelled_at TEXT,
            cancelled_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
            cancel_reason TEXT
          );

          CREATE INDEX IF NOT EXISTS idx_pickup_sign_requests_customer
          ON pickup_sign_requests(customer_id, status, expires_at);

          CREATE INDEX IF NOT EXISTS idx_pickup_sign_requests_batch
          ON pickup_sign_requests(pickup_batch_id);

          CREATE INDEX IF NOT EXISTS idx_pickup_sign_requests_created_by
          ON pickup_sign_requests(created_by, created_at);
        `);
      },
    },
  ];

  const applied = db.prepare('SELECT name FROM schema_migrations').all()
    .reduce((set, row) => set.add(row.name), new Set());
  const markApplied = db.prepare('INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)');
  for (const migration of migrations) {
    if (applied.has(migration.name)) continue;
    migration.run();
    markApplied.run(migration.name);
  }
}

function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT,
      email TEXT,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('boss', 'worker', 'customer-no-login')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone ON users(phone) WHERE phone IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL;

    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company TEXT NOT NULL,
      contact_name TEXT,
      phone TEXT,
      email TEXT,
      email_cc TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_number TEXT NOT NULL UNIQUE,
      order_number_key TEXT,
      customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
      project_name TEXT,
      priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal', 'rush', 'rework')),
      status TEXT NOT NULL DEFAULT 'in_production' CHECK (status IN ('in_production', 'ready_pickup', 'picked_up')),
      deadline TEXT,
      pdf_path TEXT,
      note TEXT,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
    CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
    CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);

    CREATE TABLE IF NOT EXISTS pieces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      piece_no INTEGER NOT NULL,
      stage TEXT NOT NULL DEFAULT 'cut' CHECK (stage IN ('cut', 'edge', 'tempered', 'polish', 'finished')),
      hold INTEGER NOT NULL DEFAULT 0,
      rework INTEGER NOT NULL DEFAULT 0,
      broken INTEGER NOT NULL DEFAULT 0,
      size TEXT,
      type TEXT,
      thickness TEXT,
      weight TEXT,
      piece_note TEXT,
      tag TEXT,
      drawing_path TEXT,
      UNIQUE(order_id, piece_no)
    );

    CREATE INDEX IF NOT EXISTS idx_pieces_order ON pieces(order_id);
    CREATE INDEX IF NOT EXISTS idx_pieces_stage ON pieces(stage);

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      piece_id INTEGER REFERENCES pieces(id) ON DELETE SET NULL,
      actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      details TEXT,
      at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_events_order ON events(order_id);

    CREATE TABLE IF NOT EXISTS pickups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      signer_name TEXT NOT NULL,
      signer_phone TEXT,
      signature_path TEXT NOT NULL DEFAULT '',
      slip_pdf_path TEXT NOT NULL,
      picked_at TEXT NOT NULL DEFAULT (datetime('now')),
      picked_by INTEGER REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS pickup_batch_counters (
      prefix TEXT PRIMARY KEY,
      next_seq INTEGER NOT NULL
    );
  `);

  const insertUser = db.prepare(`
    INSERT INTO users (phone, email, password_hash, name, role)
    VALUES (@phone, @email, @password_hash, @name, @role)
  `);
  const findUser = db.prepare('SELECT id FROM users WHERE phone = ? OR email = ?');

  if (!findUser.get('admin', 'admin')) {
    insertUser.run({
      phone: 'admin',
      email: 'admin',
      password_hash: bcrypt.hashSync('admin123', 10),
      name: 'Admin',
      role: 'boss',
    });
  }
  if (!findUser.get('worker', 'worker')) {
    insertUser.run({
      phone: 'worker',
      email: 'worker',
      password_hash: bcrypt.hashSync('worker123', 10),
      name: 'Worker',
      role: 'worker',
    });
  }
  if (process.env.SEED_DEMO_USERS === '1') {
    if (!findUser.get('bossdemo', 'bossdemo')) {
      insertUser.run({
        phone: 'bossdemo',
        email: 'bossdemo@example.test',
        password_hash: bcrypt.hashSync('boss123456', 10),
        name: 'Boss Demo',
        role: 'boss',
      });
    }
    if (!findUser.get('workerdemo', 'workerdemo')) {
      insertUser.run({
        phone: 'workerdemo',
        email: 'workerdemo@example.test',
        password_hash: bcrypt.hashSync('worker123456', 10),
        name: 'Worker Demo',
        role: 'worker',
      });
    }
  }

  db.prepare('INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)').run('initial_schema');
  migrateDb();
}

initDb();

db.runtime = {
  dbPath,
  uploadsBase,
};

module.exports = db;
