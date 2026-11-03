-- Accept invites, one per order (see src/server/inviteHandler.js).
CREATE TABLE IF NOT EXISTS invites (
  order_addr  TEXT PRIMARY KEY, -- raw order address "0:<hex>"
  courier     TEXT NOT NULL,    -- raw courier address the invite names
  valid_until INTEGER NOT NULL, -- unix seconds; the invite is void after it
  signature   TEXT NOT NULL,    -- client's Ed25519 signature, base64url
  written_at  INTEGER NOT NULL  -- unix seconds of the last write
);
