'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const component = require('./room-component');

const RULES = ['主题', '开始时间', '时长小时', '时长分钟', '优先会议室', '抢订日'];
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw new Error('会议室文件读取失败：' + path.basename(file) + '（' + error.message + '）'); }
}
class RoomBooking {
  constructor(a, deps = {}) {
    this.a = a; this.deps = deps; this.timer = null; this.starting = null; this.ticking = false;
    this.error = ''; this.lastStart = 0;
  }
  settings() { return this.a.settings().rooms || {}; }
  home() { return this.deps.roomHome || this.settings().home || (this.settings().exePath ? path.dirname(this.settings().exePath) : ''); }
  file(...parts) { if (!this.home()) throw new Error('请先选择秘书终结者程序'); return path.join(this.home(), ...parts); }
  helper() { return this.home() ? readJson(this.file('hub-control', 'status.json'), null) : null; }
  status() {
    let helper;
    try { helper = this.helper(); } catch (e) { this.error = e.message; }
    const live = helper?.protocol === 1 && this.a.now() - helper.at < 30000 && helper.at <= this.a.now() + 5000;
    return { available: !!this.deps.roomCommand || !!(this.settings().exePath && fs.existsSync(this.settings().exePath)),
      connected: !!live, running: !!(live && helper.running), mode: live ? helper.mode : null,
      loginNeeded: !!helper?.loginNeeded, loginBusy: !!(live && helper.loginBusy),
      rules: helper?.rules || null, phases: live ? helper.phases : {}, nextOpen: helper?.nextOpen,
      error: this.error, home: this.home(), exePath: this.settings().exePath || '', enabled: !!this.settings().enabled,
      targetOffsetDays: 7, events: this.a.state().roomEvents || [] };
  }
  start() {
    if (this.deps.noTimer) return;
    this.timer = setInterval(() => { void this.tick().catch(e => { this.error = e.message; this.a.changed(); }); }, 15000);
  }
  close() { clearInterval(this.timer); this.timer = null; }
  async discover() {
    const exe = await component.discover(this.a);
    if (exe && !this.settings().exePath) this.useExecutable(exe);
    return this.status();
  }
  async install() {
    const exe = await component.install(this.a, { onProgress: p => { this.error = `正在下载秘书组件：${Math.round((p.received || p.bytes || 0) / 1024 / 1024)} MB`; this.a.changed(); } });
    this.useExecutable(exe); return this.ensure();
  }
  useExecutable(exePath) {
    if (!/\.exe$/i.test(exePath) || !fs.existsSync(exePath)) throw new Error('请选择已安装的秘书终结者 exe');
    this.a.setSettings({ rooms: { exePath, home: path.dirname(exePath), enabled: false } });
    this.error = ''; return this.status();
  }
  baselineHistory() {
    if (this.a.state().roomSeen !== undefined || !this.home()) return;
    const history = readJson(this.file('booking_history.json'), []);
    if (!Array.isArray(history)) throw new Error('秘书历史格式不正确，未启动抢订');
    this.a.saveState({ roomSeen: history.map(r => createHash('sha256').update(JSON.stringify(r)).digest('hex')) });
  }
  async ensure() {
    if (this.status().connected) { this.baselineHistory(); return this.status(); }
    if (this.starting) return this.starting;
    this.starting = (async () => {
      if (!this.deps.roomCommand) await this.discover();
      const command = this.deps.roomCommand || [this.settings().exePath];
      if (!command[0] || !fs.existsSync(command[0])) throw new Error('尚未接入秘书终结者，请在设置里选择程序');
      this.baselineHistory();
      if (!this.deps.roomCommand) await component.stage(this.a, command[0], this.home());
      const child = (this.deps.roomSpawn || spawn)(command[0], [...command.slice(1), '--hub-control'], {
        cwd: path.dirname(command[0]), windowsHide: true,
        env: { ...process.env, ...(this.deps.roomEnv || {}), MSZ_HOME: this.home() }, stdio: 'ignore',
      });
      let failed = null;
      child.on('error', e => { failed = e; });
      child.unref?.();
      const end = Date.now() + 20000;
      while (Date.now() < end) {
        if (failed) throw failed;
        if (this.status().connected) { this.error = ''; return this.status(); }
        await new Promise(r => setTimeout(r, 250));
      }
      throw new Error('控制组件已准备好。若旧版秘书正在运行，请在秘书托盘退出后点「接通秘书」；Hub 不会中断正在执行的抢订。');
    })().finally(() => { this.starting = null; this.a.changed(); });
    return this.starting;
  }
  async command(op, args = {}) {
    if (!['status', 'configure', 'start', 'pause', 'login', 'show', 'test'].includes(op)) throw new Error('不支持的会议室操作');
    if (op === 'configure' && Object.keys(args).some(k => !RULES.includes(k))) throw new Error('此版本按每周规则抢七天后的会议室，不支持指定明天；请提供主题、时段、会议室和星期');
    if (op === 'status') return this.status();
    await this.ensure();
    const id = randomUUID(), req = this.file('hub-control', 'requests', id + '.json'), reply = this.file('hub-control', 'replies', id + '.json');
    fs.mkdirSync(path.dirname(req), { recursive: true });
    const tmp = req + '.tmp'; fs.writeFileSync(tmp, JSON.stringify({ id, op, args, at: this.a.now() }), 'utf8'); fs.renameSync(tmp, req);
    const end = Date.now() + 25000;
    while (Date.now() < end) {
      const result = readJson(reply, null);
      if (result) {
        if (result.requestId !== id) throw new Error('秘书回执编号不一致');
        if (!result.ok) throw new Error(result.error || '秘书未执行这项操作');
        if (op === 'start' || op === 'pause') this.a.setSettings({ rooms: { enabled: op === 'start' } });
        this.error = ''; this.a.changed(); return { ...this.status(), ...result, connected: true };
      }
      await new Promise(r => setTimeout(r, 200));
    }
    throw new Error('秘书尚未回报结果，请查看当前状态；没有自动重复执行');
  }
  async tick() {
    if (this.ticking || !this.home()) return;
    this.ticking = true;
    try {
      const now = this.a.now(), d = new Date(now), minute = d.getHours() * 60 + d.getMinutes();
      const live = this.status();
      if (this.settings().enabled && live.connected && !live.running) this.a.setSettings({ rooms: { enabled: false } });
      if (this.settings().enabled && minute >= 690 && minute < 720 && !live.connected && now - this.lastStart >= 10 * 60000) {
        this.lastStart = now; await this.command('start');
      }
      const history = readJson(this.file('booking_history.json'), []);
      if (!Array.isArray(history)) throw new Error('秘书历史格式不正确，已保留之前的结果');
      const idOf = r => createHash('sha256').update(JSON.stringify(r)).digest('hex');
      const stored = this.a.state(), prior = stored.roomSeen;
      const ids = history.map(idOf), seen = new Set(prior || ids);
      let events = stored.roomEvents || [];
      if (prior) for (const record of history) {
        const id = idOf(record);
        if (seen.has(id)) continue;
        seen.add(id);
        events = [{ id, at: now, record, phoneSent: false }, ...events].slice(0, 30);
      }
      this.a.saveState({ roomSeen: [...new Set([...(prior || []), ...ids])].slice(-200), roomEvents: events });
      for (const event of events.filter(e => !e.phoneSent).slice(0, 3)) {
        if (!this.a.phone?.active()) break;
        const r = event.record;
        const text = `会议室${r['状态'] || '结果'}：${r['日期'] || ''} ${r['时间'] || ''} ${r['会议室'] || ''}${r['备注'] ? '\n' + r['备注'] : ''}`;
        if (await this.a.phone.send(text, 'room')) {
          const latest = this.a.state().roomEvents || [];
          this.a.saveState({ roomEvents: latest.map(e => e.id === event.id ? { ...e, phoneSent: true } : e) });
        } else break;
      }
      this.error = ''; this.a.changed();
    } finally { this.ticking = false; }
  }
}
module.exports = { RoomBooking, RULES, readJson };
