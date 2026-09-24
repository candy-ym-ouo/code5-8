export const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS saves (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seed TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  year INTEGER NOT NULL,
  season TEXT NOT NULL,
  day INTEGER NOT NULL,
  slot INTEGER NOT NULL,
  action_points INTEGER NOT NULL,
  phase TEXT NOT NULL,
  current_site_id TEXT NOT NULL,
  year_start_species_json TEXT NOT NULL,
  year_start_sites_json TEXT NOT NULL,
  restoration_unlocked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_saves_session ON saves(session_id);

CREATE TABLE IF NOT EXISTS site_states (
  save_id TEXT NOT NULL REFERENCES saves(id) ON DELETE CASCADE,
  year INTEGER NOT NULL,
  site_id TEXT NOT NULL,
  weather TEXT NOT NULL,
  temperature_c REAL NOT NULL,
  humidity REAL NOT NULL,
  soil_moisture REAL NOT NULL,
  light_lux REAL NOT NULL,
  wind_speed REAL NOT NULL,
  disturbance REAL NOT NULL,
  PRIMARY KEY (save_id, year, site_id)
);

CREATE TABLE IF NOT EXISTS species_states (
  save_id TEXT NOT NULL REFERENCES saves(id) ON DELETE CASCADE,
  year INTEGER NOT NULL,
  site_id TEXT NOT NULL,
  species_id TEXT NOT NULL,
  population REAL NOT NULL,
  health REAL NOT NULL,
  seed_bank REAL NOT NULL,
  suitability REAL NOT NULL,
  status TEXT NOT NULL,
  phenology_json TEXT NOT NULL,
  PRIMARY KEY (save_id, year, site_id, species_id)
);

CREATE INDEX IF NOT EXISTS idx_species_state_lookup
  ON species_states(save_id, year, site_id);

CREATE TABLE IF NOT EXISTS environment_history (
  save_id TEXT NOT NULL REFERENCES saves(id) ON DELETE CASCADE,
  year INTEGER NOT NULL,
  season TEXT NOT NULL,
  day INTEGER NOT NULL,
  site_id TEXT NOT NULL,
  weather TEXT NOT NULL,
  temperature_c REAL NOT NULL,
  humidity REAL NOT NULL,
  soil_moisture REAL NOT NULL,
  light_lux REAL NOT NULL,
  wind_speed REAL NOT NULL,
  disturbance REAL NOT NULL,
  PRIMARY KEY (save_id, year, season, day, site_id)
);

CREATE INDEX IF NOT EXISTS idx_environment_history_lookup
  ON environment_history(save_id, year, season, site_id, day);

CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,
  save_id TEXT NOT NULL REFERENCES saves(id) ON DELETE CASCADE,
  year INTEGER NOT NULL,
  season TEXT NOT NULL,
  day INTEGER NOT NULL,
  slot INTEGER NOT NULL,
  site_id TEXT NOT NULL,
  species_id TEXT,
  kind TEXT NOT NULL,
  values_json TEXT NOT NULL,
  score REAL NOT NULL,
  feedback_json TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_observations_save_time
  ON observations(save_id, year, season, day, slot);

CREATE TABLE IF NOT EXISTS samples (
  id TEXT PRIMARY KEY,
  save_id TEXT NOT NULL REFERENCES saves(id) ON DELETE CASCADE,
  observation_id TEXT REFERENCES observations(id) ON DELETE SET NULL,
  year INTEGER NOT NULL,
  season TEXT NOT NULL,
  day INTEGER NOT NULL,
  slot INTEGER NOT NULL DEFAULT 1,
  site_id TEXT NOT NULL,
  species_id TEXT NOT NULL,
  method TEXT NOT NULL,
  protocol_match INTEGER NOT NULL,
  effects_json TEXT NOT NULL,
  disturbance_delta REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_samples_save_season
  ON samples(save_id, year, season, species_id, method);

CREATE TABLE IF NOT EXISTS season_summaries (
  id TEXT PRIMARY KEY,
  save_id TEXT NOT NULL REFERENCES saves(id) ON DELETE CASCADE,
  year INTEGER NOT NULL,
  season TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(save_id, year, season)
);

CREATE TABLE IF NOT EXISTS annual_reports (
  id TEXT PRIMARY KEY,
  save_id TEXT NOT NULL REFERENCES saves(id) ON DELETE CASCADE,
  year INTEGER NOT NULL,
  report_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(save_id, year)
);

CREATE TABLE IF NOT EXISTS game_events (
  id TEXT PRIMARY KEY,
  save_id TEXT NOT NULL REFERENCES saves(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  effects_json TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(save_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_events_save_sequence
  ON game_events(save_id, sequence DESC);

CREATE TABLE IF NOT EXISTS command_receipts (
  save_id TEXT NOT NULL REFERENCES saves(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  command_hash TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(save_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS save_exports (
  id TEXT PRIMARY KEY,
  save_id TEXT NOT NULL REFERENCES saves(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_exports_save ON save_exports(save_id);

-- 年度基线：每个自然年开始（春季第 1 日、扩散结算之后）的状态快照。
-- 年度报告的所有同比结论都以该基线为准，保证可追溯、可复核。
CREATE TABLE IF NOT EXISTS annual_baselines (
  id TEXT PRIMARY KEY,
  save_id TEXT NOT NULL REFERENCES saves(id) ON DELETE CASCADE,
  year INTEGER NOT NULL,
  species_json TEXT NOT NULL,
  sites_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(save_id, year)
);

-- 跨年度扩散台账：BEGIN_NEXT_YEAR 中实际发生的迁移事件，归属到目标年份。
CREATE TABLE IF NOT EXISTS dispersal_events (
  id TEXT PRIMARY KEY,
  save_id TEXT NOT NULL REFERENCES saves(id) ON DELETE CASCADE,
  year INTEGER NOT NULL,
  species_id TEXT NOT NULL,
  from_site_id TEXT NOT NULL,
  to_site_id TEXT NOT NULL,
  migrants REAL NOT NULL,
  source_population_after REAL NOT NULL,
  target_population_after REAL NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(save_id, year, species_id, from_site_id, to_site_id)
);

CREATE INDEX IF NOT EXISTS idx_dispersal_save_year
  ON dispersal_events(save_id, year);

-- 修复动作台账：生态修复的每次执行都独立留痕，供修复成效归因。
CREATE TABLE IF NOT EXISTS restoration_actions (
  id TEXT PRIMARY KEY,
  save_id TEXT NOT NULL REFERENCES saves(id) ON DELETE CASCADE,
  year INTEGER NOT NULL,
  season TEXT NOT NULL,
  day INTEGER NOT NULL,
  site_id TEXT NOT NULL,
  species_id TEXT,
  action TEXT NOT NULL,
  disturbance_before REAL NOT NULL,
  disturbance_after REAL NOT NULL,
  health_before REAL,
  health_after REAL,
  seed_bank_before REAL,
  seed_bank_after REAL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_restoration_save_year
  ON restoration_actions(save_id, year);

-- 历史补算报告：与正式 annual_reports 物理隔离。
-- 只允许补算 save.year 之前的年份；补算过程不触碰任何状态表，
-- 因此补算结果永远不会污染后续年份的正式报告。
CREATE TABLE IF NOT EXISTS backfilled_annual_reports (
  id TEXT PRIMARY KEY,
  save_id TEXT NOT NULL REFERENCES saves(id) ON DELETE CASCADE,
  year INTEGER NOT NULL,
  report_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(save_id, year)
);
`;
