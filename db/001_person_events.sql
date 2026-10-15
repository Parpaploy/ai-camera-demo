-- Run in a NEW ai-camera database, never in the Murata database.
CREATE TABLE IF NOT EXISTS ai_camera_person_events (
  event_id VARCHAR(160) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  session_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  camera_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  track_id BIGINT UNSIGNED NOT NULL,
  track_epoch INT UNSIGNED NOT NULL,
  source VARCHAR(16) NOT NULL,
  attire_mode VARCHAR(16) NOT NULL,
  first_seen_ms BIGINT UNSIGNED NOT NULL,
  last_seen_ms BIGINT UNSIGNED NOT NULL,
  confidence DOUBLE NOT NULL,
  attire VARCHAR(16) NOT NULL,
  gender VARCHAR(16) NOT NULL,
  age_group VARCHAR(16) NOT NULL,
  revision BIGINT UNSIGNED NOT NULL,
  received_at_ms BIGINT UNSIGNED NOT NULL,
  KEY idx_person_time (first_seen_ms, event_id),
  KEY idx_camera_time (camera_id, first_seen_ms),
  KEY idx_mode_time (attire_mode, first_seen_ms)
);
