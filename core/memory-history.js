"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { withinProject } = require("./session-search-projects");

const COVERAGE =
  "素材来自昨日之我的已保存消息正文，不是无损 wire 归档。原历史解析可能省略工具结果、附件内容或被截断；不以缺失记录证明事情没有发生。";
function candidates(index, request = {}) {
  const excluded = new Set(request.excludeSessionIds || []);
  return index.db
    .prepare(
      `SELECT s.*, sources.signature, sources.stale,
    (SELECT count(*) FROM docs d WHERE d.session_key=s.key AND d.scope<>'title') AS records
    FROM sessions s JOIN sources ON sources.key=s.source_key ORDER BY s.updated_at DESC`,
    )
    .all()
    .filter(
      (s) =>
        (request.roots || [request.cwd]).some((root) =>
          withinProject(s.cwd, root),
        ) &&
        !excluded.has(s.hub_session_id) &&
        s.records > 0,
    )
    .map((s) => ({
      key: s.key,
      title: s.title,
      provider: s.provider,
      kind: s.kind,
      cwd: s.cwd,
      updatedAt: s.updated_at,
      hubSessionId: s.hub_session_id,
      transcriptPath: s.transcript_path,
      records: s.records,
      signature: String(s.signature || ""),
      stale: !!s.stale,
    }));
}
function exportHistory(index, request) {
  if (!path.isAbsolute(request.outputDir || ""))
    throw new Error("素材输出目录无效");
  const keys = [...new Set(request.keys || [])];
  fs.mkdirSync(request.outputDir, { recursive: true });
  const manifest = {
    createdAt: new Date().toISOString(),
    cwd: request.cwd,
    coverage: COVERAGE,
    sessions: [],
    files: [],
  };
  const records = index.db.prepare(
    "SELECT event_id,role,speaker,scope,timestamp,ordinal,text FROM docs WHERE session_key=? AND scope<>'title' ORDER BY ordinal,id",
  );
  index.db.exec("BEGIN");
  try {
    // Metadata/signatures and records come from the same SQLite snapshot.
    const available = new Map(
      candidates(index, request).map((s) => [s.key, s]),
    );
    if (
      !keys.length ||
      keys.some((k) => !available.has(k) || available.get(k).stale)
    )
      throw new Error("素材已变化、没有正文或不属于当前项目，请重新选择");
    for (const [i, key] of keys.entries()) {
      const session = { ...available.get(key), files: [], exportedRecords: 0 };
      const digest = crypto.createHash("sha256");
      let chunk = "",
        part = 0;
      const flush = () => {
        if (!chunk) return;
        const name = `session-${i + 1}-${++part}.jsonl`;
        fs.writeFileSync(path.join(request.outputDir, name), chunk, "utf8");
        manifest.files.push(name);
        session.files.push(name);
        chunk = "";
      };
      for (const record of records.iterate(key)) {
        const line = JSON.stringify({ ...record, sessionKey: key }) + "\n";
        if (chunk.length + line.length > 128 * 1024) flush();
        chunk += line;
        digest.update(line);
        session.exportedRecords++;
      }
      flush();
      session.contentHash = digest.digest("hex");
      manifest.sessions.push(session);
    }
    index.db.exec("COMMIT");
  } catch (error) {
    index.db.exec("ROLLBACK");
    throw error;
  }
  fs.writeFileSync(
    path.join(request.outputDir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf8",
  );
  return manifest;
}
module.exports = { candidates, exportHistory, COVERAGE };
