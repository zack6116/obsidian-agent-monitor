const { Plugin, ItemView, PluginSettingTab, Setting, Notice } = require('obsidian');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { Dashboard, sessionAction } = (() => {
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
})();
const PYTHON_MONITOR = "#!/usr/bin/env python3\n\"\"\"Read-only local agent discovery; writes only its own Obsidian dashboard.\"\"\"\nimport argparse\nimport datetime as dt\nimport fcntl\nimport json\nimport os\nimport re\nfrom pathlib import Path\nimport sqlite3\nimport subprocess\nimport tempfile\nimport time\n\nHOME = Path.home()\n\ndef command(args):\n    result = subprocess.run(args, capture_output=True, text=True, timeout=15)\n    if result.returncode and not result.stdout:\n        raise RuntimeError(result.stderr.strip()[:160] or 'command failed')\n    return result.stdout\n\ndef rows(path, query, params=()):\n    with sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True, timeout=2) as con:\n        con.row_factory = sqlite3.Row\n        return [dict(r) for r in con.execute(query, params)]\n\ndef tail(path, size=131072):\n    with open(path, 'rb') as f:\n        f.seek(0, 2)\n        start = max(0, f.tell() - size)\n        f.seek(start)\n        data = f.read()\n    lines = data.decode('utf-8', errors='replace').splitlines()\n    if start:\n        lines = lines[1:]\n    output = []\n    for line in lines:\n        try:\n            output.append(json.loads(line))\n        except (ValueError, TypeError):\n            pass\n    return output\n\ndef epoch(value):\n    if isinstance(value, (int, float)):\n        return value / 1000 if value > 100000000000 else value\n    try:\n        return dt.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()\n    except (AttributeError, ValueError, TypeError):\n        return 0\n\ndef codex_state(events, updated, now):\n    for event in reversed(events):\n        if event.get('type') != 'event_msg':\n            continue\n        kind = event.get('payload', {}).get('type')\n        if kind in ('task_complete', 'task_completed', 'turn_complete'):\n            return '本轮已结束'\n        if kind in ('turn_aborted', 'task_aborted'):\n            return '已中断'\n        if kind in ('task_started', 'turn_started'):\n            stamp = epoch(event.get('timestamp')) or updated\n            return '执行中（事件）' if now - stamp < 600 else '未见结束事件，需确认'\n    return '近期活动，状态未确认' if now - updated < 300 else '状态未确认'\n\ndef claude_state(events, live, updated, now):\n    for event in reversed(events):\n        if event.get('type') == 'system' and event.get('subtype') == 'turn_duration':\n            return '本轮已结束'\n        if event.get('type') == 'assistant':\n            message = event.get('message', {})\n            if message.get('stop_reason') == 'end_turn':\n                return '本轮已结束'\n            content = message.get('content', [])\n            if any(isinstance(c, dict) and c.get('type') == 'tool_use' for c in content):\n                if live and now - updated < 300:\n                    return '近期工具活动（推断）'\n                return '未见结束事件，需确认'\n            break\n        if event.get('type') == 'user':\n            break\n    if live:\n        return '进程存活，任务状态未确认'\n    return '近期记录，状态未确认' if now - updated < 300 else '无匹配进程，结果未确认'\n\ndef processes():\n    output = command(['/bin/ps', '-axo', 'pid=,ppid=,comm='])\n    found = {}\n    for line in output.splitlines():\n        parts = line.strip().split(None, 2)\n        if len(parts) == 3:\n            found[int(parts[0])] = {'pid': int(parts[0]), 'ppid': int(parts[1]), 'exe': parts[2]}\n    return found\n\ndef tool_for(exe):\n    low = exe.lower()\n    if 'workbuddy.app/' in low:\n        return 'WorkBuddy'\n    if Path(exe).name.lower() == 'claude':\n        return 'Claude Code'\n    if Path(exe).name.lower() == 'codex':\n        return 'Codex'\n    return None\n\ndef cwd_for(pid):\n    try:\n        data = command(['/usr/sbin/lsof', '-a', '-p', str(pid), '-d', 'cwd', '-Fn'])\n        return unescape_lsof(next((s[1:] for s in data.splitlines() if s.startswith('n')), ''))\n    except Exception:\n        return ''\n\ndef unescape_lsof(value):\n    return re.sub(r'(?:\\\\x[0-9a-fA-F]{2})+', lambda m: bytes.fromhex(m.group().replace('\\\\x', '')).decode('utf-8', errors='replace'), value)\n\ndef listen_records(data):\n    result, current = [], {}\n    for line in data.splitlines():\n        if line.startswith('p'):\n            current = {'pid': int(line[1:]), 'name': ''}\n        elif line.startswith('c'):\n            current['name'] = unescape_lsof(line[1:])\n        elif line.startswith('n') and 'pid' in current:\n            result.append({**current, 'address': line[1:]})\n    return result\n\ndef scan(days=14):\n    now = time.time()\n    cutoff = now - days * 86400\n    errors, sessions, services = [], [], []\n    try:\n        procs = processes()\n    except Exception as e:\n        errors.append('进程检测失败：' + str(e))\n        procs = {}\n    agents = []\n    for p in procs.values():\n        tool = tool_for(p['exe'])\n        if tool and ('helper' not in p['exe'].lower()):\n            agents.append({**p, 'tool': tool, 'cwd': cwd_for(p['pid'])})\n    try:\n        records = listen_records(command(['/usr/sbin/lsof', '-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn']))\n        cwd_cache = {}\n        for r in records:\n            if r['pid'] not in cwd_cache:\n                cwd_cache[r['pid']] = cwd_for(r['pid'])\n            services.append({**r, 'cwd': cwd_cache[r['pid']]})\n    except Exception as e:\n        errors.append('端口检测失败：' + str(e))\n    try:\n        for r in rows(HOME / '.codex/state_5.sqlite',\n                      'SELECT id,cwd,title,updated_at,rollout_path FROM threads WHERE archived=0 AND updated_at>=? ORDER BY updated_at DESC LIMIT 300', (cutoff,)):\n            updated = epoch(r['updated_at'])\n            try:\n                events = tail(r['rollout_path'])\n                updated = max(updated, Path(r['rollout_path']).stat().st_mtime)\n                state = codex_state(events, updated, now)\n            except OSError:\n                state = '日志不可读，状态未确认'\n            sessions.append({'tool': 'Codex', 'id': r['id'], 'cwd': r['cwd'], 'title': r['title'], 'state': state, 'updated': updated, 'evidence': '会话数据库＋日志事件'})\n    except Exception as e:\n        errors.append('Codex 读取失败：' + str(e))\n    try:\n        for r in rows(HOME / '.workbuddy/workbuddy.db',\n                      'SELECT id,cwd,title,custom_title,status,updated_at,last_activity_at FROM sessions WHERE deleted_at IS NULL AND updated_at>=? ORDER BY updated_at DESC LIMIT 300', (cutoff * 1000,)):\n            status = r['status'].lower()\n            state = {'completed': '本轮已结束', 'error': '异常', 'terminated': '已终止', 'running': '执行中（数据库）', 'pending': '待开始'}.get(status, '原始状态：' + r['status'])\n            sessions.append({'tool': 'WorkBuddy', 'id': r['id'], 'cwd': r['cwd'], 'title': r['custom_title'] or r['title'] or r['id'], 'state': state, 'updated': max(epoch(r['updated_at']), epoch(r['last_activity_at'])), 'evidence': '会话数据库 status（非进程状态）'})\n    except Exception as e:\n        errors.append('WorkBuddy 读取失败：' + str(e))\n    try:\n        root = HOME / '.claude/projects'\n        files = list(root.glob('*/*.jsonl'))\n        files = sorted((p for p in files if p.stat().st_mtime >= cutoff), key=lambda p: p.stat().st_mtime, reverse=True)[:300]\n        live_cwds = {p['cwd'] for p in agents if p['tool'] == 'Claude Code'}\n        for path in files:\n            try:\n                events = tail(path)\n                cwd = next((e.get('cwd') for e in reversed(events) if e.get('cwd')), '')\n                if not cwd:\n                    with path.open() as f:\n                        for _ in range(30):\n                            line = f.readline()\n                            if not line:\n                                break\n                            try:\n                                cwd = json.loads(line).get('cwd', '')\n                            except ValueError:\n                                pass\n                            if cwd:\n                                break\n                updated = path.stat().st_mtime\n                sessions.append({'tool': 'Claude Code', 'id': path.stem, 'cwd': cwd or '未知目录', 'title': path.stem, 'state': claude_state(events, cwd in live_cwds, updated, now), 'updated': updated, 'evidence': '会话日志；进程仅按目录匹配，非会话绑定'})\n            except (OSError, ValueError) as e:\n                errors.append('Claude 日志不可读：' + path.name)\n    except Exception as e:\n        errors.append('Claude Code 读取失败：' + str(e))\n    return {'checked_at': now, 'sessions': sorted(sessions, key=lambda r: r['updated'], reverse=True), 'agents': agents, 'services': services, 'errors': errors, 'days': days}\n\ndef cell(value):\n    return str(value or '—').replace('|', '\\\\|').replace('\\n', ' ').replace('\\r', ' ').replace('[', '\\\\[').replace(']', '\\\\]').replace('<', '&lt;')[:240]\n\ndef stamp(value):\n    return dt.datetime.fromtimestamp(value, dt.timezone(dt.timedelta(hours=8))).strftime('%m-%d %H:%M:%S')\n\ndef table(headers, records):\n    return '\\n'.join(['| ' + ' | '.join(headers) + ' |', '| ' + ' | '.join(['---'] * len(headers)) + ' |'] + ['| ' + ' | '.join(cell(x) for x in r) + ' |' for r in records])\n\ndef render(data):\n    sessions = data['sessions']\n    attention = [s for s in sessions if any(k in s['state'] for k in ('异常', '中断', '终止', '未见结束'))]\n    active = [s for s in sessions if any(k in s['state'] for k in ('执行中', '近期', '进程存活'))]\n    def session_table(items):\n        return table(['工具', '任务／会话', '项目目录', '状态', '最近记录'], [(s['tool'], s['title'], s['cwd'], s['state'], stamp(s['updated'])) for s in items]) if items else '暂无。'\n    projects = {}\n    for s in sessions:\n        projects.setdefault(s['cwd'], []).append(s)\n    text = f'''---\ntitle: 智能体自动工作台\ntype: note\ndate: {dt.datetime.now().strftime('%Y-%m-%d')}\ntags: [agents, dashboard]\nstatus: active\n---\n\n# 智能体自动工作台\n\n自动检测时间：**{stamp(data['checked_at'])}（北京时间）** · 每 30 秒刷新 · 最近 {data['days']} 天会话\n\n发现 **{len(projects)} 个项目目录 / {len(sessions)} 个会话 / {len(data['agents'])} 个工具进程 / {len(data['services'])} 个监听地址**。\n\n“本轮已结束”表示工具完成一轮响应，不代表整个项目已验收。近期活动依据日志更新；长时间没有结束事件不等于卡死。桌面共享进程无法精确绑定单个会话。更新时间超过 2 分钟时，先检查监测服务。\n\n[[使用说明]]\n\n## 需要关注\n\n{session_table(attention)}\n\n## 执行或近期活动\n\n{session_table(active)}\n\n## 项目总览\n\n{table(['项目目录', '工具', '会话数', '最新状态', '最近记录'], [(cwd, ', '.join(sorted(set(s['tool'] for s in items))), len(items), items[0]['state'], stamp(items[0]['updated'])) for cwd, items in projects.items()])}\n\n## 工具进程（存活不等于执行任务）\n\n{table(['工具', 'PID', '工作目录'], [(p['tool'], p['pid'], p['cwd']) for p in data['agents']])}\n\n## 后台服务／监听端口\n\n{table(['进程', 'PID', '监听地址', '工作目录'], [(s['name'], s['pid'], s['address'], s['cwd']) for s in data['services']])}\n\n## 最近会话\n\n{session_table(sessions[:100])}\n\n## 检测健康\n\n'''\n    text += '\\n'.join('- ' + cell(e) for e in data['errors']) if data['errors'] else '三种会话来源及进程、端口检测均成功。'\n    return text + '\\n'\n\ndef atomic_write(path, content):\n    path.parent.mkdir(parents=True, exist_ok=True)\n    fd, temp = tempfile.mkstemp(prefix='.monitor-', dir=path.parent)\n    try:\n        with os.fdopen(fd, 'w') as f:\n            f.write(content)\n        os.replace(temp, path)\n    finally:\n        if os.path.exists(temp):\n            os.unlink(temp)\n\ndef main():\n    parser = argparse.ArgumentParser()\n    parser.add_argument('--vault', required=True, type=Path)\n    parser.add_argument('--days', type=int, default=14)\n    parser.add_argument('--output-dir', type=Path)\n    args = parser.parse_args()\n    out = args.output_dir or args.vault / '04 个人工作台/智能体工作台'\n    out.mkdir(parents=True, exist_ok=True)\n    with (out / '.monitor.lock').open('w') as lock:\n        try:\n            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)\n        except BlockingIOError:\n            return\n        data = scan(args.days)\n        atomic_write(out / '自动监测.md', render(data))\n        atomic_write(out / 'snapshot.json', json.dumps(data, ensure_ascii=False, indent=2))\n        print(json.dumps({'sessions': len(data['sessions']), 'projects': len({s['cwd'] for s in data['sessions']}), 'agents': len(data['agents']), 'services': len(data['services']), 'errors': data['errors']}, ensure_ascii=False))\n\nif __name__ == '__main__':\n    main()\n"; // Replaced with src/monitor.py by the build.
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
