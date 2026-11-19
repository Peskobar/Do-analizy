import { DatabaseSync } from 'node:sqlite';

export const DEFAULT_DB_PATH = process.env.BIO_MAP_DB_PATH || 'bio_map.db';

export function openDb(dbPath: string = DEFAULT_DB_PATH): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}

export function withTransaction<T>(dbPath: string, fn: (db: DatabaseSync) => T): T {
  const db = openDb(dbPath);
  try {
    db.exec('BEGIN');
    const result = fn(db);
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Ignore rollback errors if transaction wasn't active
    }
    throw err;
  } finally {
    db.close();
  }
}

export function initDb(dbPath: string = DEFAULT_DB_PATH): void {
  withTransaction(dbPath, (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS module (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        pair_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('PRE', 'T1')),
        t1_start_date TEXT,
        CHECK (
          (state = 'PRE' AND t1_start_date IS NULL) OR
          (state = 'T1' AND t1_start_date IS NOT NULL)
        )
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS observation (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        module_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        category TEXT NOT NULL,
        qualitative_value TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('G', 'O', 'I', 'L')),
        user_confidence TEXT NOT NULL CHECK(user_confidence IN ('LOW', 'MEDIUM', 'HIGH')),
        comment TEXT NOT NULL,
        FOREIGN KEY (module_id) REFERENCES module(id)
      )
    `);
  });
}

export function seedDb(dbPath: string = DEFAULT_DB_PATH): void {
  const seedData: Array<[string, string, string, 'PRE', null]> = [
    ['M1', 'Watermelon Zkittlez', 'P1', 'PRE', null],
    ['M2', 'Watermelon Zkittlez', 'P1', 'PRE', null],
    ['M3', "King's Banner", 'P2', 'PRE', null],
    ['M4', "King's Banner", 'P2', 'PRE', null],
    ['M5', 'Kushmallow', 'P3', 'PRE', null],
    ['M6', 'Kushmallow', 'P3', 'PRE', null],
  ];

  withTransaction(dbPath, (db) => {
    const stmt = db.prepare(`
      INSERT INTO module (id, name, pair_id, state, t1_start_date)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `);
    for (const row of seedData) {
      stmt.run(...row);
    }
  });
}
