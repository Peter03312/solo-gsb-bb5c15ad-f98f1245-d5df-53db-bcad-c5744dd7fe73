'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

function openDb(dbFile) {
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new Database(dbFile);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  tolerance_mm REAL NOT NULL DEFAULT 2.0,
  version      INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sherds (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  label      TEXT NOT NULL,
  image_file TEXT NOT NULL,
  img_w      INTEGER NOT NULL,
  img_h      INTEGER NOT NULL,
  -- 比例尺：在图上取两点，像素距离对应真实毫米长度
  scale_px   REAL,
  scale_mm   REAL,
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sherds_project ON sherds(project_id);

CREATE TABLE IF NOT EXISTS seams (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  from_id       INTEGER NOT NULL REFERENCES sherds(id) ON DELETE CASCADE,
  to_id         INTEGER NOT NULL REFERENCES sherds(id) ON DELETE CASCADE,
  theta_deg     REAL NOT NULL,
  tx            REAL NOT NULL,
  ty            REAL NOT NULL,
  join_note     TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (from_id <> to_id)
);
CREATE INDEX IF NOT EXISTS idx_seams_project ON seams(project_id);
CREATE INDEX IF NOT EXISTS idx_seams_from ON seams(from_id);
CREATE INDEX IF NOT EXISTS idx_seams_to ON seams(to_id);

-- 跨片测距：一条记录两端各是某张陶片照片上的一个测点，
-- 测点只以“所在照片的像素坐标”保存；毫米读数从不持久化，
-- 每次读取都按当前比例尺与已采纳接缝推导的位姿现算。
-- 删除陶片（ON DELETE CASCADE）会自动清除涉及它的全部测点标注。
CREATE TABLE IF NOT EXISTS measurements (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  from_sherd_id INTEGER NOT NULL REFERENCES sherds(id) ON DELETE CASCADE,
  to_sherd_id   INTEGER NOT NULL REFERENCES sherds(id) ON DELETE CASCADE,
  from_name     TEXT NOT NULL,
  to_name       TEXT NOT NULL,
  from_px       REAL NOT NULL,
  from_py       REAL NOT NULL,
  to_px         REAL NOT NULL,
  to_py         REAL NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (from_sherd_id <> to_sherd_id)
);
CREATE INDEX IF NOT EXISTS idx_measurements_project ON measurements(project_id);
CREATE INDEX IF NOT EXISTS idx_measurements_from ON measurements(from_sherd_id);
CREATE INDEX IF NOT EXISTS idx_measurements_to ON measurements(to_sherd_id);
`;

module.exports = { openDb };
