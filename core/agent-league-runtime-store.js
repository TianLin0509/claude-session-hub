'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch {
  // The Electron runtime used by Hub provides node:sqlite. Keep the failure
  // explicit instead of silently degrading to a non-transactional JSON file.
}

const RUNTIME_SCHEMA_VERSION = 1;
const DEFAULT_LEADER_TTL_MS = 20_000;
const DEFAULT_TASK_TTL_MS = 45_000;

function runtimeError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function stableJson(value) {
  return JSON.stringify(stableValue(value == null ? null : value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : stableJson(value), 'utf8').digest('hex');
}

function parseJson(value, fallback = null) {
  if (value == null || value === '') return fallback;
  try { return JSON.parse(value); }
  catch { return fallback; }
}

function positiveMs(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

class AgentLeagueRuntimeStore {
  constructor(options = {}) {
    if (!DatabaseSync) {
      throw runtimeError(
        'agent-league-sqlite-unavailable',
        '当前 Node/Electron 运行时不提供 node:sqlite，拒绝启用非事务降级版联赛运行库',
      );
    }
    const rawRoot = String(options.root || '').trim();
    if (!rawRoot) throw runtimeError('invalid-runtime-root', 'Agent League runtime root 不能为空');
    this.root = path.resolve(rawRoot);
    this.leagueId = String(options.leagueId || sha256(this.root.toLowerCase()).slice(0, 24));
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.runtimeDir = path.resolve(options.runtimeDir || path.join(this.root, '.runtime'));
    this.dbPath = path.resolve(options.dbPath || path.join(this.runtimeDir, 'agent-league.db'));
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    // Apply the busy handler before WAL/schema setup. Multiple Hub processes
    // can open a brand-new vault at the same instant; without this ordering the
    // loser may throw SQLITE_BUSY while the winner changes journal mode.
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec([
      'PRAGMA journal_mode = WAL',
      'PRAGMA synchronous = FULL',
      'PRAGMA foreign_keys = ON',
    ].join(';'));
    this._migrate();
  }

  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS league_leaders (
        league_id TEXT PRIMARY KEY,
        owner_id TEXT,
        owner_pid INTEGER,
        owner_hub TEXT,
        owner_version TEXT,
        lease_token TEXT,
        epoch INTEGER NOT NULL DEFAULT 0,
        lease_until INTEGER NOT NULL DEFAULT 0,
        heartbeat_at INTEGER NOT NULL DEFAULT 0,
        acquired_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS league_runs (
        run_key TEXT PRIMARY KEY,
        league_id TEXT NOT NULL,
        phase TEXT NOT NULL,
        decision_date TEXT NOT NULL,
        status TEXT NOT NULL,
        snapshot_id TEXT,
        input_hash TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER,
        FOREIGN KEY (league_id) REFERENCES league_leaders(league_id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS league_runs_phase_date
        ON league_runs(league_id, phase, decision_date);
      CREATE TABLE IF NOT EXISTS league_tasks (
        task_key TEXT PRIMARY KEY,
        run_key TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        stage TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt_no INTEGER NOT NULL DEFAULT 0,
        attempt_id TEXT,
        owner_id TEXT,
        owner_epoch INTEGER,
        lease_until INTEGER NOT NULL DEFAULT 0,
        input_hash TEXT NOT NULL,
        checkpoint_json TEXT,
        checkpoint_hash TEXT,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER,
        FOREIGN KEY (run_key) REFERENCES league_runs(run_key) ON DELETE CASCADE,
        UNIQUE (run_key, agent_id)
      );
      CREATE TABLE IF NOT EXISTS league_task_attempts (
        attempt_id TEXT PRIMARY KEY,
        task_key TEXT NOT NULL,
        attempt_no INTEGER NOT NULL,
        owner_id TEXT NOT NULL,
        owner_epoch INTEGER NOT NULL,
        stage TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        output_hash TEXT,
        error TEXT,
        FOREIGN KEY (task_key) REFERENCES league_tasks(task_key) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS league_effects (
        effect_key TEXT PRIMARY KEY,
        run_key TEXT NOT NULL,
        effect_type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'applied',
        payload_hash TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        result_json TEXT,
        owner_epoch INTEGER NOT NULL,
        prepared_at INTEGER NOT NULL DEFAULT 0,
        applied_at INTEGER,
        FOREIGN KEY (run_key) REFERENCES league_runs(run_key) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS league_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        league_id TEXT NOT NULL,
        run_key TEXT,
        task_key TEXT,
        event_type TEXT NOT NULL,
        owner_epoch INTEGER,
        payload_json TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS league_events_run_seq ON league_events(run_key, seq);
    `);
    const effectColumns = new Set(this.db.prepare('PRAGMA table_info(league_effects)').all().map((row) => row.name));
    if (!effectColumns.has('status')) this.db.exec("ALTER TABLE league_effects ADD COLUMN status TEXT NOT NULL DEFAULT 'applied'");
    if (!effectColumns.has('prepared_at')) this.db.exec('ALTER TABLE league_effects ADD COLUMN prepared_at INTEGER NOT NULL DEFAULT 0');
    this.db.prepare(`
      INSERT INTO runtime_meta(key, value) VALUES('schema_version', ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value
    `).run(String(RUNTIME_SCHEMA_VERSION));
  }

  _transaction(work) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  _leaderRow() {
    return this.db.prepare('SELECT * FROM league_leaders WHERE league_id = ?').get(this.leagueId) || null;
  }

  _publicLeader(row, nowMs = this.now()) {
    if (!row) return null;
    return {
      leagueId: row.league_id,
      ownerId: row.owner_id || '',
      ownerPid: Number(row.owner_pid || 0),
      ownerHub: row.owner_hub || '',
      ownerVersion: row.owner_version || '',
      epoch: Number(row.epoch || 0),
      leaseUntil: Number(row.lease_until || 0),
      heartbeatAt: Number(row.heartbeat_at || 0),
      acquiredAt: Number(row.acquired_at || 0),
      active: !!row.lease_token && Number(row.lease_until || 0) > Number(nowMs),
    };
  }

  currentLeader(nowMs = this.now()) {
    return this._publicLeader(this._leaderRow(), nowMs);
  }

  claimLeadership(owner = {}, options = {}) {
    const nowMs = Number(options.nowMs == null ? this.now() : options.nowMs);
    const ttlMs = positiveMs(options.ttlMs, DEFAULT_LEADER_TTL_MS);
    const ownerId = String(owner.ownerId || `${process.pid}-${crypto.randomBytes(8).toString('hex')}`);
    const token = crypto.randomBytes(18).toString('hex');
    return this._transaction(() => {
      const previous = this._leaderRow();
      if (previous && previous.lease_token && Number(previous.lease_until || 0) > nowMs) {
        return { ok: false, reason: 'busy', leader: this._publicLeader(previous, nowMs) };
      }
      const epoch = Number(previous && previous.epoch || 0) + 1;
      this.db.prepare(`
        INSERT INTO league_leaders(
          league_id, owner_id, owner_pid, owner_hub, owner_version,
          lease_token, epoch, lease_until, heartbeat_at, acquired_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(league_id) DO UPDATE SET
          owner_id=excluded.owner_id,
          owner_pid=excluded.owner_pid,
          owner_hub=excluded.owner_hub,
          owner_version=excluded.owner_version,
          lease_token=excluded.lease_token,
          epoch=excluded.epoch,
          lease_until=excluded.lease_until,
          heartbeat_at=excluded.heartbeat_at,
          acquired_at=excluded.acquired_at
      `).run(
        this.leagueId,
        ownerId,
        Number(owner.ownerPid || process.pid),
        String(owner.ownerHub || ''),
        String(owner.ownerVersion || ''),
        token,
        epoch,
        nowMs + ttlMs,
        nowMs,
        nowMs,
      );
      const lease = { leagueId: this.leagueId, ownerId, token, epoch, leaseUntil: nowMs + ttlMs };
      this._appendEventLocked('leader-acquired', { ownerId, ownerPid: Number(owner.ownerPid || process.pid) }, lease, nowMs);
      return { ok: true, lease, leader: this.currentLeader(nowMs) };
    });
  }

  renewLeadership(lease, options = {}) {
    const nowMs = Number(options.nowMs == null ? this.now() : options.nowMs);
    const ttlMs = positiveMs(options.ttlMs, DEFAULT_LEADER_TTL_MS);
    const result = this.db.prepare(`
      UPDATE league_leaders
      SET lease_until = ?, heartbeat_at = ?
      WHERE league_id = ? AND lease_token = ? AND epoch = ? AND owner_id = ? AND lease_until > ?
    `).run(
      nowMs + ttlMs,
      nowMs,
      this.leagueId,
      String(lease && lease.token || ''),
      Number(lease && lease.epoch || 0),
      String(lease && lease.ownerId || ''),
      nowMs,
    );
    if (!Number(result.changes || 0)) return false;
    lease.leaseUntil = nowMs + ttlMs;
    return true;
  }

  releaseLeadership(lease, options = {}) {
    const nowMs = Number(options.nowMs == null ? this.now() : options.nowMs);
    return this._transaction(() => {
      const result = this.db.prepare(`
        UPDATE league_leaders
        SET owner_id = NULL, owner_pid = NULL, owner_hub = NULL, owner_version = NULL,
            lease_token = NULL, lease_until = 0, heartbeat_at = ?
        WHERE league_id = ? AND lease_token = ? AND epoch = ? AND owner_id = ?
      `).run(
        nowMs,
        this.leagueId,
        String(lease && lease.token || ''),
        Number(lease && lease.epoch || 0),
        String(lease && lease.ownerId || ''),
      );
      if (!Number(result.changes || 0)) return false;
      this._appendEventLocked('leader-released', {}, lease, nowMs);
      return true;
    });
  }

  _assertLeaderLocked(lease, nowMs = this.now()) {
    const row = this._leaderRow();
    const valid = row
      && row.lease_token === String(lease && lease.token || '')
      && Number(row.epoch || 0) === Number(lease && lease.epoch || 0)
      && row.owner_id === String(lease && lease.ownerId || '')
      && Number(row.lease_until || 0) > Number(nowMs);
    if (!valid) {
      throw runtimeError('stale-leader-lease', '联赛写入权已经转移，拒绝旧 Hub/Runner 的迟到写入', {
        expectedEpoch: Number(lease && lease.epoch || 0),
        currentLeader: this._publicLeader(row, nowMs),
      });
    }
    return row;
  }

  assertLeadership(lease, options = {}) {
    const nowMs = Number(options.nowMs == null ? this.now() : options.nowMs);
    try { this._assertLeaderLocked(lease, nowMs); return true; }
    catch { return false; }
  }

  _appendEventLocked(eventType, payload = {}, lease = null, nowMs = this.now(), refs = {}) {
    this.db.prepare(`
      INSERT INTO league_events(league_id, run_key, task_key, event_type, owner_epoch, payload_json, created_at)
      VALUES(?, ?, ?, ?, ?, ?, ?)
    `).run(
      this.leagueId,
      refs.runKey || null,
      refs.taskKey || null,
      String(eventType),
      lease ? Number(lease.epoch || 0) : null,
      stableJson(payload),
      Number(nowMs),
    );
  }

  ensureRun(input = {}, lease, options = {}) {
    const nowMs = Number(options.nowMs == null ? this.now() : options.nowMs);
    const runKey = String(input.runKey || '').trim();
    const phase = String(input.phase || '').trim();
    const decisionDate = String(input.decisionDate || '').slice(0, 10);
    if (!runKey || !phase || !/^\d{4}-\d{2}-\d{2}$/.test(decisionDate)) {
      throw runtimeError('invalid-run-identity', 'runKey、phase 和 decisionDate 必须完整');
    }
    const taskSpecs = Array.isArray(input.taskSpecs) ? input.taskSpecs : [];
    const taskSpecByAgent = new Map(taskSpecs.map((spec) => [String(spec && spec.agentId || ''), spec || {}]));
    const participants = [...new Set([
      ...(input.participants || []).map((value) => String(value || '').trim()),
      ...taskSpecs.map((spec) => String(spec && spec.agentId || '').trim()),
    ].filter(Boolean))].sort();
    const manifest = {
      participants,
      snapshotId: String(input.snapshotId || ''),
      input: input.manifest && typeof input.manifest === 'object' ? input.manifest : {},
    };
    const inputHash = String(input.inputHash || sha256({ phase, decisionDate, manifest }));
    return this._transaction(() => {
      this._assertLeaderLocked(lease, nowMs);
      const existing = this.db.prepare('SELECT * FROM league_runs WHERE run_key = ?').get(runKey);
      if (existing) {
        if (existing.input_hash !== inputHash) {
          throw runtimeError('run-input-conflict', `运行 ${runKey} 已冻结为另一组输入`, {
            existingInputHash: existing.input_hash,
            incomingInputHash: inputHash,
          });
        }
        return { created: false, run: this._publicRun(existing) };
      }
      this.db.prepare(`
        INSERT INTO league_runs(
          run_key, league_id, phase, decision_date, status, snapshot_id,
          input_hash, manifest_json, created_at, updated_at
        ) VALUES(?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)
      `).run(
        runKey,
        this.leagueId,
        phase,
        decisionDate,
        String(input.snapshotId || ''),
        inputHash,
        stableJson(manifest),
        nowMs,
        nowMs,
      );
      const insertTask = this.db.prepare(`
        INSERT INTO league_tasks(
          task_key, run_key, agent_id, stage, status, input_hash,
          checkpoint_json, checkpoint_hash, created_at, updated_at
        ) VALUES(?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)
      `);
      for (const agentId of participants) {
        const spec = taskSpecByAgent.get(agentId) || {};
        const checkpointJson = spec.checkpoint == null ? null : stableJson(spec.checkpoint);
        insertTask.run(
          `${runKey}:agent:${agentId}`,
          runKey,
          agentId,
          String(spec.stage || input.initialStage || (phase === 'weekly' ? 'weekly' : 'draft')),
          String(spec.inputHash || sha256({ runKey, agentId, inputHash })),
          checkpointJson,
          checkpointJson == null ? null : sha256(checkpointJson),
          nowMs,
          nowMs,
        );
      }
      this._appendEventLocked('run-created', { phase, decisionDate, participants, inputHash }, lease, nowMs, { runKey });
      return { created: true, run: this.getRun(runKey) };
    });
  }

  ensureTasks(runKey, taskSpecs = [], lease, options = {}) {
    const nowMs = Number(options.nowMs == null ? this.now() : options.nowMs);
    return this._transaction(() => {
      this._assertLeaderLocked(lease, nowMs);
      const run = this.db.prepare('SELECT * FROM league_runs WHERE run_key=?').get(String(runKey || ''));
      if (!run) throw runtimeError('run-missing', `运行不存在：${runKey}`);
      const normalized = taskSpecs.map((value) => {
        if (typeof value === 'string') return { agentId: value };
        return value && typeof value === 'object' ? value : {};
      }).map((spec) => ({
        agentId: String(spec.agentId || '').trim(),
        stage: String(spec.stage || (run.phase === 'weekly' ? 'weekly' : 'draft')).trim(),
        inputHash: String(spec.inputHash || sha256({ runKey, agentId: spec.agentId, runInputHash: run.input_hash })),
        checkpoint: spec.checkpoint == null ? null : spec.checkpoint,
      })).filter((spec) => spec.agentId);
      const created = [];
      const insert = this.db.prepare(`
        INSERT OR IGNORE INTO league_tasks(
          task_key, run_key, agent_id, stage, status, input_hash,
          checkpoint_json, checkpoint_hash, created_at, updated_at
        ) VALUES(?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)
      `);
      for (const spec of normalized) {
        const taskKey = `${runKey}:agent:${spec.agentId}`;
        const checkpointJson = spec.checkpoint == null ? null : stableJson(spec.checkpoint);
        const result = insert.run(
          taskKey,
          runKey,
          spec.agentId,
          spec.stage,
          spec.inputHash,
          checkpointJson,
          checkpointJson == null ? null : sha256(checkpointJson),
          nowMs,
          nowMs,
        );
        if (Number(result.changes || 0)) {
          created.push(taskKey);
          this._appendEventLocked('task-added', { agentId: spec.agentId, stage: spec.stage }, lease, nowMs, { runKey, taskKey });
        }
      }
      if (created.length) {
        const manifest = parseJson(run.manifest_json, {});
        manifest.participants = [...new Set([
          ...(Array.isArray(manifest.participants) ? manifest.participants : []),
          ...normalized.map((spec) => spec.agentId),
        ])].sort();
        this.db.prepare(`
          UPDATE league_runs SET status='running', manifest_json=?, updated_at=?, completed_at=NULL
          WHERE run_key=?
        `).run(stableJson(manifest), nowMs, runKey);
      }
      return { created, tasks: this.listTasks(runKey), run: this.getRun(runKey) };
    });
  }

  _publicRun(row) {
    if (!row) return null;
    return {
      runKey: row.run_key,
      leagueId: row.league_id,
      phase: row.phase,
      decisionDate: row.decision_date,
      status: row.status,
      snapshotId: row.snapshot_id || '',
      inputHash: row.input_hash,
      manifest: parseJson(row.manifest_json, {}),
      createdAt: Number(row.created_at || 0),
      updatedAt: Number(row.updated_at || 0),
      completedAt: row.completed_at == null ? null : Number(row.completed_at),
    };
  }

  _publicTask(row) {
    if (!row) return null;
    return {
      taskKey: row.task_key,
      runKey: row.run_key,
      agentId: row.agent_id,
      stage: row.stage,
      status: row.status,
      attemptNo: Number(row.attempt_no || 0),
      attemptId: row.attempt_id || '',
      ownerId: row.owner_id || '',
      ownerEpoch: row.owner_epoch == null ? null : Number(row.owner_epoch),
      leaseUntil: Number(row.lease_until || 0),
      inputHash: row.input_hash,
      checkpoint: parseJson(row.checkpoint_json, null),
      checkpointHash: row.checkpoint_hash || '',
      lastError: row.last_error || '',
      createdAt: Number(row.created_at || 0),
      updatedAt: Number(row.updated_at || 0),
      completedAt: row.completed_at == null ? null : Number(row.completed_at),
    };
  }

  getRun(runKey) {
    return this._publicRun(this.db.prepare('SELECT * FROM league_runs WHERE run_key = ?').get(String(runKey || '')));
  }

  listRuns(options = {}) {
    const limit = Math.max(1, Math.min(100, Number(options.limit || 20)));
    const statuses = Array.isArray(options.statuses) ? options.statuses.map(String).filter(Boolean) : [];
    if (statuses.length) {
      const placeholders = statuses.map(() => '?').join(',');
      return this.db.prepare(`
        SELECT * FROM league_runs
        WHERE league_id=? AND status IN (${placeholders})
        ORDER BY updated_at DESC LIMIT ?
      `).all(this.leagueId, ...statuses, limit).map((row) => this._publicRun(row));
    }
    return this.db.prepare(`
      SELECT * FROM league_runs WHERE league_id=? ORDER BY updated_at DESC LIMIT ?
    `).all(this.leagueId, limit).map((row) => this._publicRun(row));
  }

  listTasks(runKey) {
    return this.db.prepare('SELECT * FROM league_tasks WHERE run_key = ? ORDER BY agent_id').all(String(runKey || '')).map((row) => this._publicTask(row));
  }

  getTask(taskKey) {
    return this._publicTask(this.db.prepare('SELECT * FROM league_tasks WHERE task_key = ?').get(String(taskKey || '')));
  }

  stageAttemptCount(taskKey, stage) {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count FROM league_task_attempts
      WHERE task_key=? AND stage=? AND status <> 'superseded-manual-retry'
    `).get(String(taskKey || ''), String(stage || ''));
    return Number(row && row.count || 0);
  }

  reopenTechnicalForfeits(runKey, agentIds = [], lease, options = {}) {
    const nowMs = Number(options.nowMs == null ? this.now() : options.nowMs);
    const requested = [...new Set(agentIds.map(String).filter(Boolean))];
    if (!requested.length) return { reopened: [], tasks: this.listTasks(runKey) };
    return this._transaction(() => {
      this._assertLeaderLocked(lease, nowMs);
      const reopened = [];
      for (const agentId of requested) {
        const row = this.db.prepare(`
          SELECT * FROM league_tasks WHERE run_key=? AND agent_id=?
        `).get(String(runKey), agentId);
        if (!row || row.status !== 'technical-forfeit') continue;
        this.db.prepare(`
          UPDATE league_task_attempts
          SET status='superseded-manual-retry'
          WHERE task_key=? AND stage=? AND status IN ('failed','retryable-failed','orphaned')
        `).run(row.task_key, row.stage);
        this.db.prepare(`
          UPDATE league_tasks
          SET status='pending', attempt_id=NULL, owner_id=NULL, owner_epoch=NULL,
              lease_until=0, completed_at=NULL, updated_at=?
          WHERE task_key=?
        `).run(nowMs, row.task_key);
        reopened.push(agentId);
        this._appendEventLocked(
          'task-manual-retry-opened',
          { agentId, stage: row.stage, previousError: row.last_error || '' },
          lease,
          nowMs,
          { runKey: row.run_key, taskKey: row.task_key },
        );
      }
      if (reopened.length) {
        this.db.prepare(`UPDATE league_runs SET status='running', completed_at=NULL, updated_at=? WHERE run_key=?`).run(nowMs, String(runKey));
      }
      return { reopened, tasks: this.listTasks(runKey), run: this.getRun(runKey) };
    });
  }

  claimTask(taskKey, lease, options = {}) {
    const nowMs = Number(options.nowMs == null ? this.now() : options.nowMs);
    const ttlMs = positiveMs(options.ttlMs, DEFAULT_TASK_TTL_MS);
    return this._transaction(() => {
      this._assertLeaderLocked(lease, nowMs);
      const row = this.db.prepare('SELECT * FROM league_tasks WHERE task_key = ?').get(String(taskKey || ''));
      if (!row) throw runtimeError('task-missing', `任务不存在：${taskKey}`);
      if (row.status === 'completed' || row.status === 'technical-forfeit') {
        return { ok: true, alreadyTerminal: true, task: this._publicTask(row) };
      }
      if (row.status === 'running' && Number(row.lease_until || 0) > nowMs) {
        return { ok: false, reason: 'task-busy', task: this._publicTask(row) };
      }
      const attemptNo = Number(row.attempt_no || 0) + 1;
      const attemptId = `${row.task_key}:attempt:${attemptNo}:${crypto.randomBytes(5).toString('hex')}`;
      this.db.prepare(`
        UPDATE league_tasks
        SET status='running', attempt_no=?, attempt_id=?, owner_id=?, owner_epoch=?,
            lease_until=?, last_error=NULL, updated_at=?
        WHERE task_key=?
      `).run(attemptNo, attemptId, lease.ownerId, lease.epoch, nowMs + ttlMs, nowMs, row.task_key);
      this.db.prepare(`
        INSERT INTO league_task_attempts(
          attempt_id, task_key, attempt_no, owner_id, owner_epoch, stage, status, started_at
        ) VALUES(?, ?, ?, ?, ?, ?, 'running', ?)
      `).run(attemptId, row.task_key, attemptNo, lease.ownerId, lease.epoch, row.stage, nowMs);
      this._appendEventLocked('task-claimed', { attemptId, attemptNo, stage: row.stage }, lease, nowMs, { runKey: row.run_key, taskKey: row.task_key });
      return { ok: true, attempt: { attemptId, attemptNo, stage: row.stage }, task: this.getTask(row.task_key) };
    });
  }

  heartbeatTask(taskKey, attemptId, lease, options = {}) {
    const nowMs = Number(options.nowMs == null ? this.now() : options.nowMs);
    const ttlMs = positiveMs(options.ttlMs, DEFAULT_TASK_TTL_MS);
    return this._transaction(() => {
      this._assertLeaderLocked(lease, nowMs);
      const result = this.db.prepare(`
        UPDATE league_tasks SET lease_until=?, updated_at=?
        WHERE task_key=? AND attempt_id=? AND status='running' AND owner_epoch=? AND owner_id=?
      `).run(nowMs + ttlMs, nowMs, String(taskKey), String(attemptId), lease.epoch, lease.ownerId);
      return Number(result.changes || 0) === 1;
    });
  }

  checkpointTask(taskKey, attemptId, checkpoint = {}, lease, options = {}) {
    const nowMs = Number(options.nowMs == null ? this.now() : options.nowMs);
    const nextStage = String(options.nextStage || checkpoint.nextStage || '').trim();
    const terminal = options.terminal === true;
    const status = terminal ? 'completed' : 'pending';
    const checkpointJson = stableJson(checkpoint);
    const checkpointHash = sha256(checkpointJson);
    return this._transaction(() => {
      this._assertLeaderLocked(lease, nowMs);
      const row = this.db.prepare('SELECT * FROM league_tasks WHERE task_key = ?').get(String(taskKey || ''));
      if (!row) throw runtimeError('task-missing', `任务不存在：${taskKey}`);
      const ownsAttempt = row.status === 'running'
        && row.attempt_id === String(attemptId || '')
        && Number(row.owner_epoch || 0) === Number(lease.epoch || 0)
        && row.owner_id === String(lease.ownerId || '');
      if (!ownsAttempt) {
        throw runtimeError('stale-task-attempt', '任务已由另一轮接管，拒绝迟到输出', {
          task: this._publicTask(row),
          attemptId: String(attemptId || ''),
        });
      }
      if (typeof options.beforeCommit === 'function') options.beforeCommit();
      this.db.prepare(`
        UPDATE league_task_attempts
        SET status='completed', finished_at=?, output_hash=?
        WHERE attempt_id=?
      `).run(nowMs, checkpointHash, attemptId);
      this.db.prepare(`
        UPDATE league_tasks
        SET stage=?, status=?, attempt_id=NULL, owner_id=NULL, owner_epoch=NULL,
            lease_until=0, checkpoint_json=?, checkpoint_hash=?, updated_at=?, completed_at=?
        WHERE task_key=?
      `).run(
        nextStage || row.stage,
        status,
        checkpointJson,
        checkpointHash,
        nowMs,
        terminal ? nowMs : null,
        row.task_key,
      );
      let nextAttempt = null;
      if (!terminal && options.claimNext === true) {
        const attemptNo = Number(row.attempt_no || 0) + 1;
        const nextAttemptId = `${row.task_key}:attempt:${attemptNo}:${crypto.randomBytes(5).toString('hex')}`;
        this.db.prepare(`
          UPDATE league_tasks
          SET status='running', attempt_no=?, attempt_id=?, owner_id=?, owner_epoch=?,
              lease_until=?, updated_at=?
          WHERE task_key=?
        `).run(
          attemptNo,
          nextAttemptId,
          lease.ownerId,
          lease.epoch,
          nowMs + positiveMs(options.taskTtlMs, DEFAULT_TASK_TTL_MS),
          nowMs,
          row.task_key,
        );
        this.db.prepare(`
          INSERT INTO league_task_attempts(
            attempt_id, task_key, attempt_no, owner_id, owner_epoch, stage, status, started_at
          ) VALUES(?, ?, ?, ?, ?, ?, 'running', ?)
        `).run(nextAttemptId, row.task_key, attemptNo, lease.ownerId, lease.epoch, nextStage || row.stage, nowMs);
        nextAttempt = { attemptId: nextAttemptId, attemptNo, stage: nextStage || row.stage };
        this._appendEventLocked(
          'task-claimed',
          nextAttempt,
          lease,
          nowMs,
          { runKey: row.run_key, taskKey: row.task_key },
        );
      }
      this._appendEventLocked(
        terminal ? 'task-completed' : 'task-checkpointed',
        { attemptId, nextStage: nextStage || row.stage, checkpointHash },
        lease,
        nowMs,
        { runKey: row.run_key, taskKey: row.task_key },
      );
      this._refreshRunStatusLocked(row.run_key, nowMs);
      return { ...this.getTask(row.task_key), ...(nextAttempt ? { nextAttempt } : {}) };
    });
  }

  failTask(taskKey, attemptId, error, lease, options = {}) {
    const nowMs = Number(options.nowMs == null ? this.now() : options.nowMs);
    const terminal = options.terminal === true;
    const message = String(error && error.message || error || 'unknown error').slice(0, 2000);
    return this._transaction(() => {
      this._assertLeaderLocked(lease, nowMs);
      const row = this.db.prepare('SELECT * FROM league_tasks WHERE task_key = ?').get(String(taskKey || ''));
      if (!row) throw runtimeError('task-missing', `任务不存在：${taskKey}`);
      if (row.attempt_id !== String(attemptId || '') || row.status !== 'running') {
        throw runtimeError('stale-task-attempt', '任务失败回报来自已经过期的 attempt');
      }
      this.db.prepare(`UPDATE league_task_attempts SET status=?, finished_at=?, error=? WHERE attempt_id=?`).run(
        terminal ? 'failed' : 'retryable-failed', nowMs, message, attemptId,
      );
      this.db.prepare(`
        UPDATE league_tasks
        SET status=?, attempt_id=NULL, owner_id=NULL, owner_epoch=NULL,
            lease_until=0, last_error=?, updated_at=?, completed_at=?
        WHERE task_key=?
      `).run(terminal ? 'technical-forfeit' : 'pending', message, nowMs, terminal ? nowMs : null, row.task_key);
      this._appendEventLocked(
        terminal ? 'task-technical-forfeit' : 'task-retry-scheduled',
        { attemptId, error: message },
        lease,
        nowMs,
        { runKey: row.run_key, taskKey: row.task_key },
      );
      this._refreshRunStatusLocked(row.run_key, nowMs);
      return this.getTask(row.task_key);
    });
  }

  recoverOrphanedTasks(lease, options = {}) {
    const nowMs = Number(options.nowMs == null ? this.now() : options.nowMs);
    return this._transaction(() => {
      this._assertLeaderLocked(lease, nowMs);
      const rows = this.db.prepare(`
        SELECT * FROM league_tasks
        WHERE status='running' AND (owner_epoch <> ? OR lease_until <= ?)
        ORDER BY task_key
      `).all(Number(lease.epoch || 0), nowMs);
      for (const row of rows) {
        if (row.attempt_id) {
          this.db.prepare(`
            UPDATE league_task_attempts SET status='orphaned', finished_at=?, error=?
            WHERE attempt_id=? AND status='running'
          `).run(nowMs, 'owner lease expired before durable completion', row.attempt_id);
        }
        this.db.prepare(`
          UPDATE league_tasks
          SET status='pending', attempt_id=NULL, owner_id=NULL, owner_epoch=NULL,
              lease_until=0, last_error=?, updated_at=?
          WHERE task_key=?
        `).run('上一运行方失联，已保留检查点等待接班', nowMs, row.task_key);
        this._appendEventLocked(
          'task-orphan-recovered',
          { previousAttemptId: row.attempt_id || '', preservedStage: row.stage },
          lease,
          nowMs,
          { runKey: row.run_key, taskKey: row.task_key },
        );
      }
      return rows.map((row) => ({ ...this._publicTask(row), status: 'pending', attemptId: '', ownerId: '', ownerEpoch: null }));
    });
  }

  _refreshRunStatusLocked(runKey, nowMs) {
    const counts = this.db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN status='technical-forfeit' THEN 1 ELSE 0 END) AS forfeited
      FROM league_tasks WHERE run_key=?
    `).get(runKey);
    const total = Number(counts && counts.total || 0);
    const completed = Number(counts && counts.completed || 0);
    const forfeited = Number(counts && counts.forfeited || 0);
    const terminal = total > 0 && completed + forfeited === total;
    const status = terminal ? (forfeited ? (completed ? 'partial' : 'failed') : 'completed') : 'running';
    this.db.prepare(`UPDATE league_runs SET status=?, updated_at=?, completed_at=? WHERE run_key=?`).run(
      status, nowMs, terminal ? nowMs : null, runKey,
    );
    return status;
  }

  recordEffect(input = {}, lease, options = {}) {
    const prepared = this.prepareEffect(input, lease, options);
    if (prepared.effect.status === 'applied') return { created: false, effect: prepared.effect };
    const completed = this.completeEffect(input.effectKey, input.result || {}, lease, options);
    return { created: prepared.created, effect: completed.effect };
  }

  prepareEffect(input = {}, lease, options = {}) {
    const nowMs = Number(options.nowMs == null ? this.now() : options.nowMs);
    const effectKey = String(input.effectKey || '').trim();
    const runKey = String(input.runKey || '').trim();
    const effectType = String(input.effectType || '').trim();
    if (!effectKey || !runKey || !effectType) throw runtimeError('invalid-effect', 'effectKey、runKey、effectType 必须完整');
    const payloadJson = stableJson(input.payload || {});
    const payloadHash = sha256(payloadJson);
    return this._transaction(() => {
      this._assertLeaderLocked(lease, nowMs);
      const existing = this.db.prepare('SELECT * FROM league_effects WHERE effect_key=?').get(effectKey);
      if (existing) {
        if (existing.payload_hash !== payloadHash) {
          throw runtimeError('effect-key-conflict', `副作用键 ${effectKey} 已绑定另一组输入`, {
            existingPayloadHash: existing.payload_hash,
            incomingPayloadHash: payloadHash,
          });
        }
        return { created: false, effect: this._publicEffect(existing) };
      }
      this.db.prepare(`
        INSERT INTO league_effects(
          effect_key, run_key, effect_type, status, payload_hash, payload_json,
          result_json, owner_epoch, prepared_at, applied_at
        ) VALUES(?, ?, ?, 'prepared', ?, ?, NULL, ?, ?, NULL)
      `).run(
        effectKey,
        runKey,
        effectType,
        payloadHash,
        payloadJson,
        Number(lease.epoch || 0),
        nowMs,
      );
      this._appendEventLocked('effect-prepared', { effectKey, effectType, payloadHash }, lease, nowMs, { runKey });
      return { created: true, effect: this.getEffect(effectKey) };
    });
  }

  completeEffect(effectKey, result = {}, lease, options = {}) {
    const nowMs = Number(options.nowMs == null ? this.now() : options.nowMs);
    return this._transaction(() => {
      this._assertLeaderLocked(lease, nowMs);
      const existing = this.db.prepare('SELECT * FROM league_effects WHERE effect_key=?').get(String(effectKey || ''));
      if (!existing) throw runtimeError('effect-missing', `副作用尚未 prepare：${effectKey}`);
      if (existing.status === 'applied') return { created: false, effect: this._publicEffect(existing) };
      const callbackResult = typeof options.beforeCommit === 'function' ? options.beforeCommit() : undefined;
      const finalResult = callbackResult === undefined ? result : callbackResult;
      this.db.prepare(`
        UPDATE league_effects
        SET status='applied', result_json=?, owner_epoch=?, applied_at=?
        WHERE effect_key=? AND status='prepared'
      `).run(stableJson(finalResult || {}), Number(lease.epoch || 0), nowMs, existing.effect_key);
      this._appendEventLocked(
        'effect-applied',
        { effectKey: existing.effect_key, effectType: existing.effect_type, payloadHash: existing.payload_hash },
        lease,
        nowMs,
        { runKey: existing.run_key },
      );
      return { created: true, effect: this.getEffect(existing.effect_key) };
    });
  }

  _publicEffect(row) {
    if (!row) return null;
    return {
      effectKey: row.effect_key,
      runKey: row.run_key,
      effectType: row.effect_type,
      status: row.status || 'applied',
      payloadHash: row.payload_hash,
      payload: parseJson(row.payload_json, {}),
      result: parseJson(row.result_json, {}),
      ownerEpoch: Number(row.owner_epoch || 0),
      preparedAt: Number(row.prepared_at || 0),
      appliedAt: row.applied_at == null ? null : Number(row.applied_at),
    };
  }

  getEffect(effectKey) {
    return this._publicEffect(this.db.prepare('SELECT * FROM league_effects WHERE effect_key=?').get(String(effectKey || '')));
  }

  listEvents(runKey = '') {
    const rows = runKey
      ? this.db.prepare('SELECT * FROM league_events WHERE run_key=? ORDER BY seq').all(String(runKey))
      : this.db.prepare('SELECT * FROM league_events WHERE league_id=? ORDER BY seq').all(this.leagueId);
    return rows.map((row) => ({
      seq: Number(row.seq),
      runKey: row.run_key || '',
      taskKey: row.task_key || '',
      eventType: row.event_type,
      ownerEpoch: row.owner_epoch == null ? null : Number(row.owner_epoch),
      payload: parseJson(row.payload_json, {}),
      createdAt: Number(row.created_at),
    }));
  }

  quickCheck() {
    try {
      const rows = this.db.prepare('PRAGMA quick_check').all();
      const messages = rows.map((row) => String(row.quick_check || Object.values(row)[0] || '')).filter(Boolean);
      return { ok: messages.length === 1 && messages[0].toLowerCase() === 'ok', messages };
    } catch (error) {
      return { ok: false, messages: [String(error && error.message || error)] };
    }
  }

  close() {
    if (!this.db) return false;
    this.db.close();
    this.db = null;
    return true;
  }
}

module.exports = {
  AgentLeagueRuntimeStore,
  DEFAULT_LEADER_TTL_MS,
  DEFAULT_TASK_TTL_MS,
  RUNTIME_SCHEMA_VERSION,
  sha256,
  stableJson,
};
