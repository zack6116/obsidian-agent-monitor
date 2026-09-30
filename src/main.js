const { Plugin, ItemView, PluginSettingTab, Setting, Notice } = require('obsidian');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { Dashboard, sessionAction } = require('./dashboard');
const PYTHON_MONITOR = ''; // Replaced with src/monitor.py by the build.
const VIEW = 'agent-monitor-dashboard';
const defaults = { outputDir: path.join(os.homedir(), 'Library/Application Support/AgentMonitor/dashboard'), python: '/usr/bin/python3', days: 14 };

class MonitorView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; }
  getViewType() { return VIEW; }
  getDisplayText() { return '智能体工作台'; }
  getIcon() { return 'layout-dashboard'; }
  async onOpen() {
    this.contentEl.classList.add('agent-monitor-view');
    this.ui = new Dashboard(this.contentEl, { refresh: () => this.plugin.detect(true), openSession: session => this.plugin.openSession(session), openFolder: async cwd => { try { const { shell } = require('electron'); const error = await shell.openPath(cwd); if (error) new Notice(error); } catch (e) { new Notice('无法打开目录：' + e.message); } }, settings: () => { this.app.setting.open(); this.app.setting.openTabById(this.plugin.manifest.id); } });
    await this.reload(); this.registerInterval(window.setInterval(() => this.reload(), 5000));
  }
  async reload() {
    if (!this.ui) return;
    try {
      const text = await fs.readFile(path.join(this.plugin.settings.outputDir, 'snapshot.json'), 'utf8');
      const data = JSON.parse(text);
      if (!Array.isArray(data.sessions) || !Array.isArray(data.services) || !Array.isArray(data.agents)) throw new Error('检测数据格式不正确');
      if (text !== this.lastText) { this.lastText = text; this.ui.update(data); } else if (Date.now() / 1000 - data.checked_at > 120) this.ui.error('检测数据超过 2 分钟未更新，请刷新或检查监测服务。');
    } catch (e) { this.ui.error('无法读取检测数据，请点击刷新检测。' + e.message); }
  }
  async onClose() { this.ui?.destroy(); this.ui = null; }
}

class MonitorSettings extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl: el } = this; el.empty();
    el.createEl('p', { text: '只读检测本机工具，数据保存在本地。插件启用时自动检测；现有登录后台任务继续工作。' });
    new Setting(el).setName('检测数据目录').setDesc('默认使用已部署的本地监测目录。').addText(t => t.setValue(this.plugin.settings.outputDir).onChange(async value => { this.plugin.settings.outputDir = value.trim() || defaults.outputDir; await this.plugin.saveSettings(); }));
    new Setting(el).setName('Python 路径').setDesc('用于运行插件附带的无依赖检测器。').addText(t => t.setValue(this.plugin.settings.python).onChange(async value => { this.plugin.settings.python = value.trim() || defaults.python; await this.plugin.saveSettings(); }));
    new Setting(el).setName('会话回溯天数').addDropdown(d => d.addOptions({ '7': '最近 7 天', '14': '最近 14 天', '30': '最近 30 天' }).setValue(String(this.plugin.settings.days)).onChange(async value => { this.plugin.settings.days = Number(value); await this.plugin.saveSettings(); await this.plugin.detect(true); }));
    new Setting(el).setName('打开工作台').addButton(b => b.setButtonText('打开').onClick(() => this.plugin.openDashboard()));
  }
}

module.exports = class AgentMonitorPlugin extends Plugin {
  async onload() {
    this.settings = { ...defaults, ...await this.loadData() }; this.busy = false; this.unloaded = false;
    this.registerView(VIEW, leaf => new MonitorView(leaf, this));
    this.addRibbonIcon('layout-dashboard', '智能体工作台', () => this.openDashboard());
    this.addCommand({ id: 'open-dashboard', name: '打开智能体工作台', callback: () => this.openDashboard() });
    this.addCommand({ id: 'refresh-detection', name: '立即检测项目与会话', callback: () => this.detect(true) });
    this.addSettingTab(new MonitorSettings(this.app, this));
    this.registerInterval(window.setInterval(() => this.detect(false), 30000));
    this.app.workspace.onLayoutReady(() => this.detect(false));
  }
  async openSession(session) {
    const action = sessionAction(session);
    if (!action) { new Notice('此记录没有可用的会话跳转方式'); return; }
    try {
      if (action.kind === 'link') await require('electron').shell.openExternal(action.url);
      else { require('electron').clipboard.writeText(action.command); new Notice('已复制恢复命令，在终端粘贴运行即可恢复该会话'); }
    } catch (e) { new Notice('打开会话失败：' + e.message); }
  }
  async saveSettings() { await this.saveData(this.settings); }
  async openDashboard() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW)[0];
    if (!leaf) { leaf = this.app.workspace.getLeaf('tab'); await leaf.setViewState({ type: VIEW, active: true }); }
    await this.app.workspace.revealLeaf(leaf);
  }
  async detect(manual) {
    if (this.unloaded) return;
    if (process.platform !== 'darwin') { if (manual) new Notice('当前自动检测仅支持 macOS'); return; }
    if (this.busy) { if (manual) new Notice('检测正在进行'); return; }
    this.busy = true;
    try {
      if (!manual) { try { const data = JSON.parse(await fs.readFile(path.join(this.settings.outputDir, 'snapshot.json'), 'utf8')); if (Date.now() / 1000 - data.checked_at < 25 && data.days === this.settings.days) return; } catch (_) {} }
      const base = this.app.vault.adapter.getBasePath();
      await new Promise((resolve, reject) => {
        this.child = execFile(this.settings.python, ['-c', PYTHON_MONITOR, '--vault', base, '--output-dir', this.settings.outputDir, '--days', String(this.settings.days)], { timeout: 60000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => { this.child = null; if (error) reject(new Error(stderr.trim().slice(-500) || error.message)); else resolve(stdout); });
      });
      if (!this.unloaded) for (const leaf of this.app.workspace.getLeavesOfType(VIEW)) await leaf.view.reload();
      if (manual) new Notice('检测完成');
    } catch (e) { for (const leaf of this.app.workspace.getLeavesOfType(VIEW)) leaf.view.ui?.error('检测失败：' + e.message); if (manual) new Notice('检测失败：' + e.message); }
    finally { this.busy = false; }
  }
  onunload() { this.unloaded = true; if (this.child) this.child.kill(); }
};
