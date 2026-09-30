#!/usr/bin/env python3
"""Read-only local agent discovery; writes only its own Obsidian dashboard."""
import argparse
import datetime as dt
import fcntl
import json
import os
import re
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import time

HOME = Path.home()

def command(args):
    result = subprocess.run(args, capture_output=True, text=True, timeout=15)
    if result.returncode and not result.stdout:
        raise RuntimeError(result.stderr.strip()[:160] or 'command failed')
    return result.stdout

def rows(path, query, params=()):
    with sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True, timeout=2) as con:
        con.row_factory = sqlite3.Row
        return [dict(r) for r in con.execute(query, params)]

def tail(path, size=131072):
    with open(path, 'rb') as f:
        f.seek(0, 2)
        start = max(0, f.tell() - size)
        f.seek(start)
        data = f.read()
    lines = data.decode('utf-8', errors='replace').splitlines()
    if start:
        lines = lines[1:]
    output = []
    for line in lines:
        try:
            output.append(json.loads(line))
        except (ValueError, TypeError):
            pass
    return output

def epoch(value):
    if isinstance(value, (int, float)):
        return value / 1000 if value > 100000000000 else value
    try:
        return dt.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()
    except (AttributeError, ValueError, TypeError):
        return 0

def codex_state(events, updated, now):
    for event in reversed(events):
        if event.get('type') != 'event_msg':
            continue
        kind = event.get('payload', {}).get('type')
        if kind in ('task_complete', 'task_completed', 'turn_complete'):
            return '本轮已结束'
        if kind in ('turn_aborted', 'task_aborted'):
            return '已中断'
        if kind in ('task_started', 'turn_started'):
            stamp = epoch(event.get('timestamp')) or updated
            return '执行中（事件）' if now - stamp < 600 else '未见结束事件，需确认'
    return '近期活动，状态未确认' if now - updated < 300 else '状态未确认'

def claude_state(events, live, updated, now):
    for event in reversed(events):
        if event.get('type') == 'system' and event.get('subtype') == 'turn_duration':
            return '本轮已结束'
        if event.get('type') == 'assistant':
            message = event.get('message', {})
            if message.get('stop_reason') == 'end_turn':
                return '本轮已结束'
            content = message.get('content', [])
            if any(isinstance(c, dict) and c.get('type') == 'tool_use' for c in content):
                if live and now - updated < 300:
                    return '近期工具活动（推断）'
                return '未见结束事件，需确认'
            break
        if event.get('type') == 'user':
            break
    if live:
        return '进程存活，任务状态未确认'
    return '近期记录，状态未确认' if now - updated < 300 else '无匹配进程，结果未确认'

def processes():
    output = command(['/bin/ps', '-axo', 'pid=,ppid=,comm='])
    found = {}
    for line in output.splitlines():
        parts = line.strip().split(None, 2)
        if len(parts) == 3:
            found[int(parts[0])] = {'pid': int(parts[0]), 'ppid': int(parts[1]), 'exe': parts[2]}
    return found

def tool_for(exe):
    low = exe.lower()
    if 'workbuddy.app/' in low:
        return 'WorkBuddy'
    if Path(exe).name.lower() == 'claude':
        return 'Claude Code'
    if Path(exe).name.lower() == 'codex':
        return 'Codex'
    return None

def cwd_for(pid):
    try:
        data = command(['/usr/sbin/lsof', '-a', '-p', str(pid), '-d', 'cwd', '-Fn'])
        return unescape_lsof(next((s[1:] for s in data.splitlines() if s.startswith('n')), ''))
    except Exception:
        return ''

def unescape_lsof(value):
    return re.sub(r'(?:\\x[0-9a-fA-F]{2})+', lambda m: bytes.fromhex(m.group().replace('\\x', '')).decode('utf-8', errors='replace'), value)

def listen_records(data):
    result, current = [], {}
    for line in data.splitlines():
        if line.startswith('p'):
            current = {'pid': int(line[1:]), 'name': ''}
        elif line.startswith('c'):
            current['name'] = unescape_lsof(line[1:])
        elif line.startswith('n') and 'pid' in current:
            result.append({**current, 'address': line[1:]})
    return result

def scan(days=14):
    now = time.time()
    cutoff = now - days * 86400
    errors, sessions, services = [], [], []
    try:
        procs = processes()
    except Exception as e:
        errors.append('进程检测失败：' + str(e))
        procs = {}
    agents = []
    for p in procs.values():
        tool = tool_for(p['exe'])
        if tool and ('helper' not in p['exe'].lower()):
            agents.append({**p, 'tool': tool, 'cwd': cwd_for(p['pid'])})
    try:
        records = listen_records(command(['/usr/sbin/lsof', '-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn']))
        cwd_cache = {}
        for r in records:
            if r['pid'] not in cwd_cache:
                cwd_cache[r['pid']] = cwd_for(r['pid'])
            services.append({**r, 'cwd': cwd_cache[r['pid']]})
    except Exception as e:
        errors.append('端口检测失败：' + str(e))
    try:
        for r in rows(HOME / '.codex/state_5.sqlite',
                      'SELECT id,cwd,title,updated_at,rollout_path FROM threads WHERE archived=0 AND updated_at>=? ORDER BY updated_at DESC LIMIT 300', (cutoff,)):
            updated = epoch(r['updated_at'])
            try:
                events = tail(r['rollout_path'])
                updated = max(updated, Path(r['rollout_path']).stat().st_mtime)
                state = codex_state(events, updated, now)
            except OSError:
                state = '日志不可读，状态未确认'
            sessions.append({'tool': 'Codex', 'id': r['id'], 'cwd': r['cwd'], 'title': r['title'], 'state': state, 'updated': updated, 'evidence': '会话数据库＋日志事件'})
    except Exception as e:
        errors.append('Codex 读取失败：' + str(e))
    try:
        for r in rows(HOME / '.workbuddy/workbuddy.db',
                      'SELECT id,cwd,title,custom_title,status,updated_at,last_activity_at FROM sessions WHERE deleted_at IS NULL AND updated_at>=? ORDER BY updated_at DESC LIMIT 300', (cutoff * 1000,)):
            status = r['status'].lower()
            state = {'completed': '本轮已结束', 'error': '异常', 'terminated': '已终止', 'running': '执行中（数据库）', 'pending': '待开始'}.get(status, '原始状态：' + r['status'])
            sessions.append({'tool': 'WorkBuddy', 'id': r['id'], 'cwd': r['cwd'], 'title': r['custom_title'] or r['title'] or r['id'], 'state': state, 'updated': max(epoch(r['updated_at']), epoch(r['last_activity_at'])), 'evidence': '会话数据库 status（非进程状态）'})
    except Exception as e:
        errors.append('WorkBuddy 读取失败：' + str(e))
    try:
        root = HOME / '.claude/projects'
        files = list(root.glob('*/*.jsonl'))
        files = sorted((p for p in files if p.stat().st_mtime >= cutoff), key=lambda p: p.stat().st_mtime, reverse=True)[:300]
        live_cwds = {p['cwd'] for p in agents if p['tool'] == 'Claude Code'}
        for path in files:
            try:
                events = tail(path)
                cwd = next((e.get('cwd') for e in reversed(events) if e.get('cwd')), '')
                if not cwd:
                    with path.open() as f:
                        for _ in range(30):
                            line = f.readline()
                            if not line:
                                break
                            try:
                                cwd = json.loads(line).get('cwd', '')
                            except ValueError:
                                pass
                            if cwd:
                                break
                updated = path.stat().st_mtime
                sessions.append({'tool': 'Claude Code', 'id': path.stem, 'cwd': cwd or '未知目录', 'title': path.stem, 'state': claude_state(events, cwd in live_cwds, updated, now), 'updated': updated, 'evidence': '会话日志；进程仅按目录匹配，非会话绑定'})
            except (OSError, ValueError) as e:
                errors.append('Claude 日志不可读：' + path.name)
    except Exception as e:
        errors.append('Claude Code 读取失败：' + str(e))
    return {'checked_at': now, 'sessions': sorted(sessions, key=lambda r: r['updated'], reverse=True), 'agents': agents, 'services': services, 'errors': errors, 'days': days}

def cell(value):
    return str(value or '—').replace('|', '\\|').replace('\n', ' ').replace('\r', ' ').replace('[', '\\[').replace(']', '\\]').replace('<', '&lt;')[:240]

def stamp(value):
    return dt.datetime.fromtimestamp(value, dt.timezone(dt.timedelta(hours=8))).strftime('%m-%d %H:%M:%S')

def table(headers, records):
    return '\n'.join(['| ' + ' | '.join(headers) + ' |', '| ' + ' | '.join(['---'] * len(headers)) + ' |'] + ['| ' + ' | '.join(cell(x) for x in r) + ' |' for r in records])

def render(data):
    sessions = data['sessions']
    attention = [s for s in sessions if any(k in s['state'] for k in ('异常', '中断', '终止', '未见结束'))]
    active = [s for s in sessions if any(k in s['state'] for k in ('执行中', '近期', '进程存活'))]
    def session_table(items):
        return table(['工具', '任务／会话', '项目目录', '状态', '最近记录'], [(s['tool'], s['title'], s['cwd'], s['state'], stamp(s['updated'])) for s in items]) if items else '暂无。'
    projects = {}
    for s in sessions:
        projects.setdefault(s['cwd'], []).append(s)
    text = f'''---
title: 智能体自动工作台
type: note
date: {dt.datetime.now().strftime('%Y-%m-%d')}
tags: [agents, dashboard]
status: active
---

# 智能体自动工作台

自动检测时间：**{stamp(data['checked_at'])}（北京时间）** · 每 30 秒刷新 · 最近 {data['days']} 天会话

发现 **{len(projects)} 个项目目录 / {len(sessions)} 个会话 / {len(data['agents'])} 个工具进程 / {len(data['services'])} 个监听地址**。

“本轮已结束”表示工具完成一轮响应，不代表整个项目已验收。近期活动依据日志更新；长时间没有结束事件不等于卡死。桌面共享进程无法精确绑定单个会话。更新时间超过 2 分钟时，先检查监测服务。

[[使用说明]]

## 需要关注

{session_table(attention)}

## 执行或近期活动

{session_table(active)}

## 项目总览

{table(['项目目录', '工具', '会话数', '最新状态', '最近记录'], [(cwd, ', '.join(sorted(set(s['tool'] for s in items))), len(items), items[0]['state'], stamp(items[0]['updated'])) for cwd, items in projects.items()])}

## 工具进程（存活不等于执行任务）

{table(['工具', 'PID', '工作目录'], [(p['tool'], p['pid'], p['cwd']) for p in data['agents']])}

## 后台服务／监听端口

{table(['进程', 'PID', '监听地址', '工作目录'], [(s['name'], s['pid'], s['address'], s['cwd']) for s in data['services']])}

## 最近会话

{session_table(sessions[:100])}

## 检测健康

'''
    text += '\n'.join('- ' + cell(e) for e in data['errors']) if data['errors'] else '三种会话来源及进程、端口检测均成功。'
    return text + '\n'

def atomic_write(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(prefix='.monitor-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as f:
            f.write(content)
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--vault', required=True, type=Path)
    parser.add_argument('--days', type=int, default=14)
    parser.add_argument('--output-dir', type=Path)
    args = parser.parse_args()
    out = args.output_dir or args.vault / '04 个人工作台/智能体工作台'
    out.mkdir(parents=True, exist_ok=True)
    with (out / '.monitor.lock').open('w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        data = scan(args.days)
        atomic_write(out / '自动监测.md', render(data))
        atomic_write(out / 'snapshot.json', json.dumps(data, ensure_ascii=False, indent=2))
        print(json.dumps({'sessions': len(data['sessions']), 'projects': len({s['cwd'] for s in data['sessions']}), 'agents': len(data['agents']), 'services': len(data['services']), 'errors': data['errors']}, ensure_ascii=False))

if __name__ == '__main__':
    main()
