CREATE SCHEMA IF NOT EXISTS windward;
REVOKE ALL ON SCHEMA windward FROM PUBLIC;

CREATE TABLE IF NOT EXISTS windward.game_accounts (
  id VARCHAR(36) PRIMARY KEY,
  username VARCHAR(24) NOT NULL UNIQUE,
  display_name VARCHAR(32) NOT NULL,
  password_hash VARCHAR(192) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS windward.game_sessions (
  token_hash VARCHAR(64) PRIMARY KEY,
  account_id VARCHAR(36) NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS session_account ON windward.game_sessions (account_id);
CREATE INDEX IF NOT EXISTS session_expiry ON windward.game_sessions (expires_at);
CREATE TABLE IF NOT EXISTS windward.game_matches (
  id VARCHAR(36) PRIMARY KEY,
  mode VARCHAR(12) NOT NULL,
  winner INTEGER NOT NULL,
  duration_seconds INTEGER NOT NULL,
  finished_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS windward.game_match_players (
  match_id VARCHAR(36) NOT NULL,
  slot INTEGER NOT NULL,
  account_id VARCHAR(36),
  player_name VARCHAR(32) NOT NULL,
  PRIMARY KEY (match_id, slot)
);
CREATE INDEX IF NOT EXISTS player_history ON windward.game_match_players (account_id, match_id);
