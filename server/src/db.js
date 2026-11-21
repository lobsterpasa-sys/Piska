import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Открывает SQLite-базу. По умолчанию — в памяти (для тестов).
 * В продакшене передайте путь к файлу (DB_FILE) или замените на PostgreSQL.
 */
export function openDb(file = ':memory:') {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
      username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      created_at    INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS subscriptions (
      user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      plan       TEXT NOT NULL,
      expires_at INTEGER,
      auto_renew INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS payments (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      plan       TEXT NOT NULL,
      months     INTEGER NOT NULL,
      amount     REAL NOT NULL,
      provider   TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS app_links (
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      app           TEXT NOT NULL,
      first_used_at INTEGER NOT NULL,
      last_used_at  INTEGER NOT NULL,
      PRIMARY KEY (user_id, app)
    );
    CREATE TABLE IF NOT EXISTS friendships (
      requester_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      addressee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status       TEXT NOT NULL CHECK (status IN ('pending', 'accepted')),
      created_at   INTEGER NOT NULL,
      PRIMARY KEY (requester_id, addressee_id)
    );
    CREATE INDEX IF NOT EXISTS friendships_addressee ON friendships(addressee_id);
  `);
  // Миграция для баз, созданных до появления token_version.
  const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!cols.includes('token_version')) db.exec('ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0');
  return db;
}
