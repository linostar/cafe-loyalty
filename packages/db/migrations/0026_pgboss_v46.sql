-- migration: expand
-- pg-boss 12.38's schema (version 46): getMigrationPlans('pgboss', 45) from pg-boss 12.38.1, with the edits 0007 made
-- to its construction plans: less its own BEGIN/COMMIT, lock, timeouts and version guard (the migrator runs each file
-- once, in one transaction, under its own lock). Its four new job_common indexes, which pg-boss builds CONCURRENTLY
-- afterwards (impossible inside a transaction), are built here through pgboss.job_table_run as 0007 builds the others:
-- job_common holds only the few jobs this service keeps, so the short lock is harmless. 0007's grants cover the new
-- column (table-wide) and the replaced function (CREATE OR REPLACE keeps them).
-- A release from before pg-boss 12.38 refuses this version: its worker does not start and its server runs without
-- the queue (README, Job queue), so a rollback past it still serves.

ALTER TABLE pgboss.queue ADD COLUMN IF NOT EXISTS retained_count int, ADD COLUMN IF NOT EXISTS retained_on timestamp with time zone;

    CREATE OR REPLACE FUNCTION pgboss.create_queue(queue_name text, options jsonb)
    RETURNS VOID AS
    $$
    DECLARE
    tablename varchar := CASE WHEN options->>'partition' = 'true'
    THEN 'j' || encode(sha224(queue_name::bytea), 'hex')
    ELSE 'job_common'
    END;
    queue_created_on timestamptz;
    BEGIN

    WITH q as (
    INSERT INTO pgboss.queue (
    name,
    policy,
    retry_limit,
    retry_delay,
    retry_backoff,
    retry_delay_max,
    expire_seconds,
    retention_seconds,
    deletion_seconds,
    warning_queued,
    dead_letter,
    partition,
    table_name,
    heartbeat_seconds,
    notify,
    created_on,
    updated_on
    )
    VALUES (
    queue_name,
    options->>'policy',
    COALESCE((options->>'retryLimit')::int, 2),
    COALESCE((options->>'retryDelay')::int, 0),
    COALESCE((options->>'retryBackoff')::bool, false),
    (options->>'retryDelayMax')::int,
    COALESCE((options->>'expireInSeconds')::int, 900),
    COALESCE((options->>'retentionSeconds')::int, 1209600),
    COALESCE((options->>'deleteAfterSeconds')::int, 604800),
    COALESCE((options->>'warningQueueSize')::int, 0),
    options->>'deadLetter',
    COALESCE((options->>'partition')::bool, false),
    tablename,
    (options->>'heartbeatSeconds')::int,
    COALESCE((options->>'notify')::bool, false),
    pgboss.job_now(),
    pgboss.job_now()
    )
    ON CONFLICT DO NOTHING
    RETURNING created_on
    )
    SELECT created_on into queue_created_on from q;

    IF queue_created_on IS NULL OR options->>'partition' IS DISTINCT FROM 'true' THEN
    RETURN;
    END IF;

    EXECUTE format('CREATE TABLE pgboss.%I (LIKE pgboss.job INCLUDING DEFAULTS)', tablename);

    EXECUTE pgboss.job_table_format($cmd$ALTER TABLE pgboss.job ADD PRIMARY KEY (name, id)$cmd$, tablename);
    EXECUTE pgboss.job_table_format($cmd$ALTER TABLE pgboss.job ADD CONSTRAINT q_fkey FOREIGN KEY (name) REFERENCES pgboss.queue (name) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED$cmd$, tablename);
    EXECUTE pgboss.job_table_format($cmd$ALTER TABLE pgboss.job ADD CONSTRAINT dlq_fkey FOREIGN KEY (dead_letter) REFERENCES pgboss.queue (name) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED$cmd$, tablename);

    EXECUTE pgboss.job_table_format($cmd$CREATE INDEX job_i11 ON pgboss.job (name, priority DESC, created_on, start_after) WHERE state < 'active' AND NOT blocked$cmd$, tablename);
    EXECUTE pgboss.job_table_format($cmd$CREATE UNIQUE INDEX job_i4 ON pgboss.job (name, singleton_on, COALESCE(singleton_key, '')) WHERE state <> 'cancelled' AND singleton_on IS NOT NULL$cmd$, tablename);
    EXECUTE pgboss.job_table_format($cmd$CREATE INDEX job_i7 ON pgboss.job (name, group_id) WHERE state = 'active' AND group_id IS NOT NULL$cmd$, tablename);
    EXECUTE pgboss.job_table_format($cmd$CREATE INDEX job_i9 ON pgboss.job (name, id) WHERE blocking AND state = 'completed'$cmd$, tablename);
    EXECUTE pgboss.job_table_format($cmd$CREATE INDEX job_i12 ON pgboss.job (source_root_id) WHERE source_root_id IS NOT NULL$cmd$, tablename);
    EXECUTE pgboss.job_table_format($cmd$CREATE UNIQUE INDEX job_i13 ON pgboss.job (name, singleton_key) WHERE state = 'created' AND upsert_by_key$cmd$, tablename);
    EXECUTE pgboss.job_table_format($cmd$CREATE INDEX job_i14 ON pgboss.job (name, state, blocked, start_after) WHERE state IN ('created', 'retry', 'active', 'failed')$cmd$, tablename);
    EXECUTE pgboss.job_table_format($cmd$CREATE INDEX job_i15 ON pgboss.job (name, created_on)$cmd$, tablename);
    EXECUTE pgboss.job_table_format($cmd$CREATE INDEX job_i16 ON pgboss.job (name, completed_on) WHERE completed_on IS NOT NULL$cmd$, tablename);
    EXECUTE pgboss.job_table_format($cmd$CREATE INDEX job_i17 ON pgboss.job (name, singleton_key, created_on) WHERE state < 'active' AND singleton_key IS NOT NULL$cmd$, tablename);

    IF options->>'policy' = 'short' THEN
    EXECUTE pgboss.job_table_format($cmd$CREATE UNIQUE INDEX job_i1 ON pgboss.job (name, COALESCE(singleton_key, '')) WHERE state = 'created' AND policy = 'short'$cmd$, tablename);
    ELSIF options->>'policy' = 'singleton' THEN
    EXECUTE pgboss.job_table_format($cmd$CREATE UNIQUE INDEX job_i2 ON pgboss.job (name, COALESCE(singleton_key, '')) WHERE state = 'active' AND policy = 'singleton'$cmd$, tablename);
    ELSIF options->>'policy' = 'stately' THEN
    EXECUTE pgboss.job_table_format($cmd$CREATE UNIQUE INDEX job_i3 ON pgboss.job (name, state, COALESCE(singleton_key, '')) WHERE state <= 'active' AND policy = 'stately'$cmd$, tablename);
    ELSIF options->>'policy' = 'exclusive' THEN
    EXECUTE pgboss.job_table_format($cmd$CREATE UNIQUE INDEX job_i6 ON pgboss.job (name, COALESCE(singleton_key, '')) WHERE state <= 'active' AND policy = 'exclusive'$cmd$, tablename);
    ELSIF options->>'policy' = 'key_strict_fifo' THEN
    EXECUTE pgboss.job_table_format($cmd$CREATE UNIQUE INDEX job_i8 ON pgboss.job (name, singleton_key) WHERE state IN ('active', 'retry', 'failed') AND policy = 'key_strict_fifo'$cmd$, tablename);
    EXECUTE pgboss.job_table_format($cmd$CREATE INDEX job_i10 ON pgboss.job (name, singleton_key, state DESC, created_on, id) INCLUDE (start_after) WHERE state < 'active' AND NOT blocked AND policy = 'key_strict_fifo'$cmd$, tablename);
    EXECUTE pgboss.job_table_format($cmd$ALTER TABLE pgboss.job ADD CONSTRAINT job_key_strict_fifo_singleton_key_check CHECK (NOT (policy = 'key_strict_fifo' AND singleton_key IS NULL))$cmd$, tablename);
    END IF;

    EXECUTE format('ALTER TABLE pgboss.%I ADD CONSTRAINT cjc CHECK (name=%L)', tablename, queue_name);
    EXECUTE format('ALTER TABLE pgboss.job ATTACH PARTITION pgboss.%I FOR VALUES IN (%L)', tablename, queue_name);
    END;
    $$
    LANGUAGE plpgsql;

-- The indexes pg-boss would build CONCURRENTLY after its migration (job_table_run_async), on job_common.
SELECT pgboss.job_table_run($cmd$CREATE INDEX IF NOT EXISTS job_i14 ON pgboss.job (name, state, blocked, start_after) WHERE state IN ('created', 'retry', 'active', 'failed')$cmd$, 'job_common');
SELECT pgboss.job_table_run($cmd$CREATE INDEX IF NOT EXISTS job_i15 ON pgboss.job (name, created_on)$cmd$, 'job_common');
SELECT pgboss.job_table_run($cmd$CREATE INDEX IF NOT EXISTS job_i16 ON pgboss.job (name, completed_on) WHERE completed_on IS NOT NULL$cmd$, 'job_common');
SELECT pgboss.job_table_run($cmd$CREATE INDEX IF NOT EXISTS job_i17 ON pgboss.job (name, singleton_key, created_on) WHERE state < 'active' AND singleton_key IS NOT NULL$cmd$, 'job_common');

UPDATE pgboss.version SET version = '46';
