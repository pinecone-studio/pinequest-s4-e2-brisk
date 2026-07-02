-- Event lifecycle: littering evidence starts "active" and becomes "handled"
-- once the trash is removed from the scene. handled_at is null until then.
ALTER TABLE evidence_events ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE evidence_events ADD COLUMN handled_at INTEGER;
