const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { sessionAction, category, projectGroups } = require('../src/dashboard');
const id = '550e8400-e29b-41d4-a716-446655440000';

test('session links use supported schemes and validated IDs', () => {
  assert.equal(sessionAction({ tool: 'Codex', id }).url, 'codex://threads/' + id);
  assert.equal(sessionAction({ tool: 'WorkBuddy', id }).url, 'workbuddy://chat/' + id);
  assert.equal(sessionAction({ tool: 'Codex', id: '../other' }), null);
});
test('resume command quotes directories without evaluating shell input', () => {
  const result = sessionAction({ tool: 'Claude Code', id, cwd: "/tmp/a'b $(echo hi)" });
  assert.equal(result.command, "cd -- '/tmp/a'\\''b $(echo hi)' && claude --resume '" + id + "'");
});
test('unknown activity remains distinct from completion', () => {
  assert.equal(category('状态未确认'), 'unknown');
  assert.equal(category('本轮已结束'), 'ended');
  const projects = projectGroups({ sessions: [{ cwd: '/demo', tool: 'Codex', state: '状态未确认', updated: 1 }] });
  assert.equal(projects[0].category, 'unknown');
});
test('release loads with an Obsidian-like require without local files', () => {
  const required = [];
  const context = { module: { exports: {} }, console, require(id) {
    required.push(id);
    if (id === 'obsidian') return { Plugin: class {}, ItemView: class {}, PluginSettingTab: class {}, Setting: class {}, Notice: class {} };
    if (id.startsWith('.')) throw new Error('Local files are not supported');
    return require(id);
  } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../main.js'), 'utf8'), context);
  assert.equal(typeof context.module.exports, 'function');
  assert.ok(!required.some(id => id.startsWith('.')));
});
