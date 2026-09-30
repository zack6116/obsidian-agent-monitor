(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AgentDashboard = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const icons = {
    home: '<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z"/>',
    folder: '<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    chat: '<path d="M21 11a8 8 0 0 1-8 8H7l-4 3V5a2 2 0 0 1 2-2h8a8 8 0 0 1 8 8z"/><path d="M7 8h9M7 12h6"/>',
    server: '<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6h.01M7 17h.01"/>',
    refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 6a8 8 0 0 1 14 6M18 18A8 8 0 0 1 4 12"/>',
    search: '<circle cx="10" cy="10" r="7"/><path d="m15 15 6 6"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="m9 3-1 3-3 1-2 3 2 2-1 3 3 2 3-1 2 2 3-2v-3l3-2-1-3-3-1-1-3z"/>',
    arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>'
  };
  function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; }
  function icon(name) { const n = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); n.setAttribute('viewBox', '0 0 24 24'); n.setAttribute('fill', 'none'); n.setAttribute('stroke', 'currentColor'); n.setAttribute('stroke-width', '1.7'); n.setAttribute('stroke-linecap', 'round'); n.setAttribute('stroke-linejoin', 'round'); n.setAttribute('aria-hidden', 'true'); for (const match of (icons[name] || icons.folder).matchAll(/<(path|rect|circle)\s+([^>]+)\/>/g)) { const child = document.createElementNS('http://www.w3.org/2000/svg', match[1]); for (const attr of match[2].matchAll(/([\w-]+)="([^"]*)"/g)) child.setAttribute(attr[1], attr[2]); n.append(child); } return n; }
  function button(label, cls, fn, ico) { const n = el('button', cls); n.type = 'button'; n.setAttribute('aria-label', label); if (ico) n.append(icon(ico)); n.append(el('span', '', label)); n.addEventListener('click', fn); return n; }
  function category(state) { if (/异常|中断|终止|未见结束/.test(state)) return 'attention'; if (/执行中|近期|进程存活/.test(state)) return 'active'; if (/本轮已结束/.test(state)) return 'ended'; return 'unknown'; }
  const labels = { all: '全部', active: '近期活动', attention: '需要关注', ended: '本轮结束', unknown: '未确认' };
  function when(time) { return time ? new Date(time * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'; }
  function name(path) { return path.replace(/\/$/, '').split('/').pop() || path; }
  function projectGroups(data) {
    const map = new Map();
    for (const session of data.sessions || []) {
      if (!map.has(session.cwd)) map.set(session.cwd, { cwd: session.cwd, title: name(session.cwd), sessions: [], updated: 0 });
      const p = map.get(session.cwd); p.sessions.push(session); p.updated = Math.max(p.updated, session.updated || 0);
    }
    const priority = { active: 0, attention: 1, unknown: 2, ended: 3 };
    for (const p of map.values()) { p.sessions.sort((a, b) => b.updated - a.updated); p.tools = [...new Set(p.sessions.map(s => s.tool))]; p.category = Object.keys(priority).find(c => p.sessions.some(s => category(s.state) === c)) || 'unknown'; }
    return [...map.values()].sort((a, b) => priority[a.category] - priority[b.category] || b.updated - a.updated);
  }
  function sessionAction(session) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(session.id || '')) return null;
    if (session.tool === 'Codex') return { kind: 'link', label: '打开会话', url: 'codex://threads/' + encodeURIComponent(session.id) };
    if (session.tool === 'WorkBuddy') return { kind: 'link', label: '打开会话', url: 'workbuddy://chat/' + encodeURIComponent(session.id) };
    if (session.tool === 'Claude Code') {
      const quote = value => "'" + String(value).replace(/'/g, "'\\''") + "'";
      const prefix = typeof session.cwd === 'string' && session.cwd.startsWith('/') ? 'cd -- ' + quote(session.cwd) + ' && ' : '';
      return { kind: 'clipboard', label: '复制恢复命令', command: prefix + 'claude --resume ' + quote(session.id) };
    }
    return null;
  }
  class Dashboard {
    constructor(container, actions = {}) { this.container = container; this.actions = actions; this.mode = 'projects'; this.tool = 'all'; this.filter = 'all'; this.query = ''; this.selected = null; this.limit = 50; this.data = { sessions: [], agents: [], services: [], errors: [] }; this.build(); }
    build() {
      this.container.replaceChildren(); this.root = el('div', 'am-app'); this.container.append(this.root);
      this.sidebar = el('aside', 'am-sidebar'); this.root.append(this.sidebar);
      const brand = el('div', 'am-brand'); brand.append(el('div', 'am-brand-symbol', 'A'), el('div', 'am-brand-text', 'Agent Monitor')); brand.append(el('small', '', '智能体工作台')); this.sidebar.append(brand);
      this.nav = el('nav', 'am-nav'); this.sidebar.append(this.nav);
      [['projects', '工作台', 'home'], ['sessions', '会话', 'chat'], ['services', '后台服务', 'server']].forEach(([mode, label, ico]) => this.nav.append(button(label, 'am-nav-button', () => { this.mode = mode; this.selected = null; this.limit = 50; this.paint(); }, ico)));
      this.sidebar.append(el('div', 'am-sidebar-label', '工具筛选')); this.toolNav = el('nav', 'am-nav'); this.sidebar.append(this.toolNav);
      ['all', 'Codex', 'Claude Code', 'WorkBuddy'].forEach(tool => { const b = button(tool === 'all' ? '全部工具' : tool, 'am-nav-button', () => { this.tool = tool; this.selected = null; this.limit = 50; this.paint(); }); b.dataset.short = { all: '全', Codex: 'C', 'Claude Code': 'CC', WorkBuddy: 'W' }[tool]; b.title = tool === 'all' ? '全部工具' : tool; this.toolNav.append(b); });
      this.sidebar.append(button('设置', 'am-settings', () => this.actions.settings?.(), 'settings'));
      this.main = el('main', 'am-main'); this.root.append(this.main);
      const header = el('header', 'am-header'); const heading = el('div'); this.title = el('h1', '', '智能体工作台'); heading.append(this.title, el('p', '', '自动发现项目与会话，让每一项工作都有迹可循。')); header.append(heading);
      this.refresh = button('刷新检测', 'am-button', async () => { if (this.refresh.disabled) return; this.refresh.disabled = true; this.refresh.classList.add('is-busy'); try { await this.actions.refresh?.(); } finally { this.refresh.disabled = false; this.refresh.classList.remove('is-busy'); } }, 'refresh'); header.append(this.refresh); this.main.append(header);
      this.stats = el('div', 'am-stats'); this.main.append(this.stats);
      this.health = el('div', 'am-alert'); this.main.append(this.health);
      const searchWrap = el('label', 'am-search'); searchWrap.append(icon('search')); this.search = el('input'); this.search.type = 'search'; this.search.placeholder = '搜索项目、会话或目录…'; this.search.setAttribute('aria-label', '搜索项目、会话或目录'); this.search.addEventListener('input', () => { this.query = this.search.value.toLowerCase().trim(); this.limit = 50; this.paintBody(); }); searchWrap.append(this.search); this.main.append(searchWrap);
      this.tabs = el('div', 'am-tabs'); this.tabs.setAttribute('role', 'group'); this.tabs.setAttribute('aria-label', '状态筛选'); this.main.append(this.tabs);
      this.body = el('div', 'am-body'); this.main.append(this.body);
      this.footer = el('footer', 'am-footer'); this.main.append(this.footer); this.paint();
    }
    update(data) { this.data = data; this.paint(); }
    error(message) { this.health.hidden = false; this.health.textContent = message; this.health.classList.add('is-warning'); }
    paint() {
      [...this.nav.children].forEach((n, i) => n.classList.toggle('is-selected', ['projects', 'sessions', 'services'][i] === this.mode));
      [...this.toolNav.children].forEach((n, i) => n.classList.toggle('is-selected', ['all', 'Codex', 'Claude Code', 'WorkBuddy'][i] === this.tool));
      const d = this.data; this.stats.replaceChildren();
      [['项目', projectGroups(d).length, 'folder'], ['会话', d.sessions?.length || 0, 'chat'], ['工具进程', d.agents?.length || 0, 'settings'], ['监听地址', d.services?.length || 0, 'server']].forEach(([label, value, ico]) => { const card = el('div', 'am-stat'); card.append(icon(ico)); const text = el('div'); text.append(el('span', '', label), el('strong', '', String(value))); card.append(text); this.stats.append(card); });
      const age = Date.now() / 1000 - (d.checked_at || 0); const stale = age > 120;
      this.health.hidden = !stale && !(d.errors || []).length; this.health.classList.toggle('is-warning', stale || !!d.errors?.length); this.health.textContent = [stale ? '检测数据超过 2 分钟未更新，请刷新或检查监测服务。' : '', ...(d.errors || [])].filter(Boolean).join(' ');
      this.footer.replaceChildren(el('span', stale || d.errors?.length ? 'am-health-warning' : 'am-health-ok', stale ? '数据待更新' : d.errors?.length ? '部分检测异常' : '检测正常'), el('span', '', `最近更新 ${when(d.checked_at)} · 最近 ${d.days || 14} 天 · 30 秒自动检测`));
      this.paintBody();
    }
    items() {
      let sessions = (this.data.sessions || []).filter(s => this.tool === 'all' || s.tool === this.tool);
      if (this.mode === 'services') {
        return (this.data.services || []).filter(s => { if (this.tool !== 'all' && !(this.data.agents || []).some(a => a.pid === s.pid && a.tool === this.tool) && !sessions.some(a => a.cwd === s.cwd)) return false; return !this.query || `${s.name} ${s.cwd} ${s.address} ${s.pid}`.toLowerCase().includes(this.query); });
      }
      if (this.mode === 'sessions') return sessions.filter(s => (!this.query || `${s.title} ${s.cwd} ${s.id}`.toLowerCase().includes(this.query)));
      return projectGroups({ sessions }).filter(p => !this.query || `${p.title} ${p.cwd} ${p.sessions.map(s => s.title).join(' ')}`.toLowerCase().includes(this.query));
    }
    paintBody() {
      let items = this.items(); this.tabs.replaceChildren(); this.tabs.hidden = this.mode === 'services';
      if (this.mode !== 'services') for (const f of ['all', 'active', 'attention', 'ended', 'unknown']) {
        const count = items.filter(p => f === 'all' || (this.mode === 'projects' ? p.category : category(p.state)) === f).length;
        const b = button(`${labels[f]} ${count}`, 'am-tab' + (this.filter === f ? ' is-selected' : ''), () => { this.filter = f; this.selected = null; this.limit = 50; this.paintBody(); }); b.setAttribute('aria-pressed', String(this.filter === f)); this.tabs.append(b);
      }
      if (this.mode !== 'services') items = items.filter(p => this.filter === 'all' || (this.mode === 'projects' ? p.category : category(p.state)) === this.filter);
      this.body.replaceChildren(); this.body.classList.toggle('has-detail', !!this.selected && this.mode !== 'services');
      const list = el('section', 'am-list'); this.body.append(list);
      if (!items.length) { list.append(el('div', 'am-empty', '没有符合条件的记录'), el('p', 'am-empty-sub', '试试其他工具或状态，或者清空搜索。')); return; }
      if (this.mode === 'services') { const t = el('table', 'am-service-table'); const head = el('thead'); const tr = el('tr'); ['进程', 'PID', '监听地址', '工作目录'].forEach(x => tr.append(el('th', '', x))); head.append(tr); t.append(head); const tbody = el('tbody'); items.slice(0, this.limit).forEach(s => { const row = el('tr'); [s.name, s.pid, s.address, s.cwd || '未知'].forEach(v => row.append(el('td', '', String(v)))); tbody.append(row); }); t.append(tbody); list.append(t); }
      else { const listHead = el('div', 'am-list-head'); listHead.append(el('span', '', this.mode === 'projects' ? '项目' : '会话'), el('span', '', '状态 / 最近记录')); list.append(listHead);
        items.slice(0, this.limit).forEach(p => {
          const key = this.mode === 'projects' ? p.cwd : `${p.tool}:${p.id}`;
          const row = el('button', 'am-row' + (this.selected === key ? ' is-selected' : '')); row.type = 'button'; row.addEventListener('click', () => { this.selected = this.selected === key ? null : key; this.paintBody(); });
          const folder = el('div', 'am-folder-icon'); folder.append(icon(this.mode === 'projects' ? 'folder' : 'chat')); row.append(folder);
          const text = el('div', 'am-row-text'); text.append(el('strong', '', p.title || p.id), el('span', 'am-path', p.cwd)); const tags = el('div', 'am-tool-tags'); (p.tools || [p.tool]).forEach(tool => tags.append(el('span', 'am-tool-tag', tool))); if (p.sessions) tags.append(el('span', 'am-session-count', `${p.sessions.length} 个会话`)); text.append(tags); row.append(text);
          const meta = el('div', 'am-row-meta'); const state = this.mode === 'projects' ? labels[p.category] : p.state; const cat = this.mode === 'projects' ? p.category : category(p.state); meta.append(el('span', 'am-state am-state-' + cat, state), el('time', '', when(p.updated))); row.append(meta); list.append(row);
        });
      }
      if (items.length > this.limit) list.append(button(`显示更多 · 还有 ${items.length - this.limit} 条`, 'am-more', () => { this.limit += 50; this.paintBody(); }));
      if (this.selected && this.mode !== 'services') { const p = items.find(p => (this.mode === 'projects' ? p.cwd : `${p.tool}:${p.id}`) === this.selected); if (p) this.detail(p); }
    }
    detail(p) {
      const side = el('aside', 'am-detail'); this.body.append(side); const header = el('div', 'am-detail-header'); header.append(el('h2', '', this.mode === 'projects' ? p.title : name(p.cwd)), button('关闭详情', 'am-icon-button', () => { this.selected = null; this.paintBody(); }, 'close')); side.append(header, el('p', 'am-detail-path', p.cwd));
      side.append(button('打开项目文件夹', 'am-button am-folder-button', () => this.actions.openFolder?.(p.cwd), 'folder'));
      const sessions = p.sessions || [p]; const live = (this.data.agents || []).filter(a => a.cwd === p.cwd); const services = (this.data.services || []).filter(s => s.cwd === p.cwd);
      side.append(el('h3', '', '运行证据')); const facts = el('dl', 'am-facts'); [['匹配进程', live.length ? live.map(a => `${a.tool} · PID ${a.pid}`).join(' / ') : '未匹配到工具进程'], ['监听地址', services.length ? services.map(s => s.address).join(' / ') : '未匹配到监听地址'], ['最近记录', when(p.updated)]].forEach(([key, value]) => { facts.append(el('dt', '', key), el('dd', '', value)); }); side.append(facts, el('p', 'am-evidence-note', '进程按目录匹配。进程存活不代表该会话正在执行；本轮结束不代表项目已验收。'));
      side.append(el('h3', '', `关联会话 · ${sessions.length}`)); sessions.slice(0, 25).forEach(s => { const card = el('div', 'am-session'); card.append(el('div', 'am-session-title', s.title || s.id), el('span', 'am-state am-state-' + category(s.state), s.state), el('p', '', `${s.tool} · ${when(s.updated)}`), el('small', '', s.evidence)); const id = el('code', '', s.id); id.title = s.id; card.append(id); const action = sessionAction(s); if (action) card.append(button(action.label, 'am-button am-session-open', () => this.actions.openSession?.(s), 'arrow')); side.append(card); }); if (sessions.length > 25) side.append(el('small', '', '显示最近 25 个会话，可切换“会话”搜索全部记录。'));
    }
    destroy() { this.container.replaceChildren(); }
  }
  return { Dashboard, category, projectGroups, sessionAction };
});
