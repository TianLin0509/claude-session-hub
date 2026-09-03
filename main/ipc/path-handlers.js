'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { shell } = require('electron');
const { searchPreviewPaths } = require('../../core/preview-path-search.js');
const { listWorkspaceDirectory } = require('../../core/file-manager-directory.js');

const COMPANY_DROP_TIMEOUT_MS = 15 * 60 * 1000;
const COMPANY_DROP_MAX_OUTPUT_BYTES = 1024 * 1024;

const READ_FILE_EXTS = new Set([
  '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl',
  '.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.hpp', '.cs',
  '.txt', '.log', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.sh', '.bat', '.ps1', '.xml', '.sql', '.r', '.rb', '.php',
  '.swift', '.kt', '.lua', '.zig', '.asm', '.css', '.scss', '.less',
]);

function resolveCompanyDropRuntime({
  env = process.env,
  homeDir = os.homedir(),
  existsSync = fs.existsSync,
} = {}) {
  const localAppData = env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local');
  const pythonCandidates = [
    env.COMPANY_DROP_PYTHON,
    path.join(localAppData, 'Programs', 'Python', 'Python312', 'python.exe'),
    path.join(localAppData, 'Programs', 'Python', 'Python313', 'python.exe'),
  ].filter(Boolean);
  const clientCandidates = [
    env.COMPANY_DROP_CLIENT,
    path.join(homeDir, 'company-drop', 'client', 'company_drop.py'),
  ].filter(Boolean);
  const pythonPath = pythonCandidates.find(candidate => existsSync(candidate));
  const clientPath = clientCandidates.find(candidate => existsSync(candidate));
  if (!pythonPath) {
    return { error: '未找到 Company Drop 使用的 Python，请检查本机安装。' };
  }
  if (!clientPath) {
    return { error: '未找到 Company Drop 客户端，请检查 C:\\Users\\<用户名>\\company-drop\\client。' };
  }
  return { pythonPath, clientPath };
}

function parseCompanyDropOutput(stdout, stderr, exitCode) {
  const lines = String(stdout || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  let envelope = null;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      envelope = JSON.parse(lines[index]);
      break;
    } catch (_) {
      // Ignore non-JSON diagnostic lines and keep looking for the final envelope.
    }
  }
  if (!envelope || typeof envelope !== 'object') {
    return {
      error: String(stderr || '').trim() || '同步程序没有返回有效结果。',
      code: 'invalid_response',
    };
  }
  if (exitCode !== 0 || envelope.ok !== true) {
    const error = envelope.error && typeof envelope.error === 'object' ? envelope.error : {};
    return {
      error: error.message || String(stderr || '').trim() || `同步程序退出码：${exitCode}`,
      code: error.code || 'sync_failed',
      details: error.details,
    };
  }
  const data = envelope.data && typeof envelope.data === 'object' ? envelope.data : {};
  const head = data.public_head && typeof data.public_head === 'object' ? data.public_head : {};
  if (Number(head.status) !== 200 || Number(head.content_length) !== Number(data.size)) {
    return {
      error: '同步程序未通过公网文件校验。',
      code: 'public_verify_failed',
      details: { expected: data.size, actual: head },
    };
  }
  return { ...data, success: true };
}

function runCompanyDrop(filePath, {
  spawnImpl = spawn,
  runtimeOptions,
  timeoutMs = COMPANY_DROP_TIMEOUT_MS,
  maxOutputBytes = COMPANY_DROP_MAX_OUTPUT_BYTES,
} = {}) {
  const runtime = resolveCompanyDropRuntime(runtimeOptions);
  if (runtime.error) return Promise.resolve(runtime);

  return new Promise((resolve) => {
    const child = spawnImpl(runtime.pythonPath, [
      runtime.clientPath,
      'send',
      filePath,
      '--json',
      '--no-clipboard',
    ], {
      windowsHide: true,
      cwd: os.homedir(),
      env: {
        ...process.env,
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8',
      },
    });
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let settled = false;
    let timer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    const append = (target, chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        child.kill();
        finish({ error: '同步程序输出异常，操作已停止。', code: 'output_limit' });
        return target;
      }
      return target + chunk.toString('utf8');
    };

    if (child.stdout) child.stdout.on('data', chunk => { stdout = append(stdout, chunk); });
    if (child.stderr) child.stderr.on('data', chunk => { stderr = append(stderr, chunk); });
    child.on('error', error => finish({
      error: `无法启动同步程序：${String(error && error.message || error)}`,
      code: 'spawn_failed',
    }));
    child.on('close', code => finish(parseCompanyDropOutput(stdout, stderr, code)));
    timer = setTimeout(() => {
      child.kill();
      finish({ error: '同步超时，请检查网络后重试。', code: 'timeout' });
    }, timeoutMs);
  });
}

function registerPathIpc(ipcMain, deps = {}) {
  const syncRunner = deps.runCompanyDrop || runCompanyDrop;
  const previewPathSearcher = deps.searchPreviewPaths || searchPreviewPaths;
  const directoryLister = deps.listWorkspaceDirectory || listWorkspaceDirectory;
  const companyDropInFlight = new Set();
  ipcMain.handle('open-path', async (_e, filePath) => {
    if (typeof filePath !== 'string' || !filePath.trim()) return 'empty path';
    try {
      return await shell.openPath(filePath);
    } catch (e) {
      return String(e && e.message || e);
    }
  });

  ipcMain.handle('read-file', async (_e, filePath) => {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) return { error: 'invalid path' };
    const ext = path.extname(filePath).toLowerCase();
    if (!READ_FILE_EXTS.has(ext)) return { error: 'unsupported extension' };
    try {
      const stat = await fs.promises.stat(filePath);
      if (stat.size > 5 * 1024 * 1024) return { error: 'file too large (>5MB)' };
      const content = await fs.promises.readFile(filePath, 'utf-8');
      return { content };
    } catch (e) {
      return { error: String(e && e.message || e) };
    }
  });

  ipcMain.handle('preview:search-paths', async (_e, payload) => {
    if (!payload || typeof payload !== 'object') {
      return { results: [], source: 'invalid', truncated: false, indexedCount: 0 };
    }
    try {
      return await previewPathSearcher({
        query: typeof payload.query === 'string' ? payload.query : '',
        cwd: typeof payload.cwd === 'string' ? payload.cwd : null,
        limit: payload.limit,
      });
    } catch (error) {
      return {
        results: [],
        source: 'error',
        truncated: false,
        indexedCount: 0,
        error: String(error && error.message || error),
      };
    }
  });

  ipcMain.handle('file-manager:list-directory', async (_e, payload) => {
    if (!payload || typeof payload !== 'object') {
      return { ok: false, error: 'invalid payload', code: 'invalid_payload', entries: [] };
    }
    try {
      return await directoryLister({
        root: typeof payload.root === 'string' ? payload.root : '',
        directory: typeof payload.directory === 'string' ? payload.directory : '',
        limit: payload.limit,
      });
    } catch (error) {
      return {
        ok: false,
        error: String(error && error.message || error),
        code: 'read_failed',
        entries: [],
      };
    }
  });

  ipcMain.handle('open-external-url', async (_e, url) => {
    if (!url || !/^https?:\/\//i.test(url)) return { success: false };
    await shell.openExternal(url);
    return { success: true };
  });

  ipcMain.handle('show-in-folder', async (_e, filePath) => {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
      return { error: 'invalid path' };
    }
    if (!fs.existsSync(filePath)) return { error: 'file not found' };
    try {
      shell.showItemInFolder(filePath);
      return { success: true };
    } catch (e) {
      return { error: String(e && e.message || e) };
    }
  });

  ipcMain.handle('clipboard-copy-file', async (_e, filePath) => {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
      return { error: 'invalid path' };
    }
    try {
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile() && !stat.isDirectory()) {
        return { error: 'not a file or directory' };
      }
    } catch (e) {
      return { error: 'file not found' };
    }

    if (process.platform !== 'win32') {
      return { error: 'platform not supported' };
    }

    return new Promise((resolve) => {
      const escaped = filePath.replace(/'/g, "''");
      const ps = spawn('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Set-Clipboard -LiteralPath '${escaped}'`,
      ], { windowsHide: true });

      let stderr = '';
      ps.stderr.on('data', (d) => { stderr += d.toString(); });
      ps.on('close', (code) => {
        if (code === 0) resolve({ success: true });
        else resolve({ error: stderr.trim() || `exit ${code}` });
      });
      ps.on('error', (e) => resolve({ error: String(e && e.message || e) }));
    });
  });

  ipcMain.handle('sync-path-to-company', async (_e, filePath) => {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
      return { error: '路径无效。', code: 'invalid_path' };
    }
    const normalizedPath = path.resolve(filePath);
    try {
      const stat = await fs.promises.stat(normalizedPath);
      if (!stat.isFile() && !stat.isDirectory()) {
        return { error: '只支持文件或文件夹。', code: 'unsupported_path' };
      }
    } catch (_) {
      return { error: '文件或文件夹不存在。', code: 'not_found' };
    }

    const inFlightKey = process.platform === 'win32' ? normalizedPath.toLowerCase() : normalizedPath;
    if (companyDropInFlight.has(inFlightKey)) {
      return { error: '该路径正在同步，请稍候。', code: 'already_syncing' };
    }
    companyDropInFlight.add(inFlightKey);
    try {
      return await syncRunner(normalizedPath, deps.companyDropOptions);
    } catch (error) {
      return {
        error: String(error && error.message || error),
        code: 'sync_failed',
      };
    } finally {
      companyDropInFlight.delete(inFlightKey);
    }
  });
}

module.exports = {
  COMPANY_DROP_MAX_OUTPUT_BYTES,
  COMPANY_DROP_TIMEOUT_MS,
  READ_FILE_EXTS,
  parseCompanyDropOutput,
  registerPathIpc,
  resolveCompanyDropRuntime,
  runCompanyDrop,
};
