import json
from pathlib import Path
import tempfile
import unittest
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
import monitor

class MonitorTests(unittest.TestCase):
    def test_codex_completion_survives_settings_events(self):
        events = [{'type': 'event_msg', 'payload': {'type': 'task_complete'}}, {'type': 'event_msg', 'payload': {'type': 'thread_settings_applied'}}]
        self.assertEqual(monitor.codex_state(events, 100, 101), '本轮已结束')

    def test_old_start_is_not_claimed_running(self):
        events = [{'type': 'event_msg', 'timestamp': '2026-01-01T00:00:00Z', 'payload': {'type': 'task_started'}}]
        self.assertIn('需确认', monitor.codex_state(events, 100, 1790740000))

    def test_missing_events_not_completed(self):
        self.assertIn('未确认', monitor.codex_state([], 100, 101))

    def test_claude_old_completion_not_applied_to_new_user_turn(self):
        events = [{'type': 'assistant', 'message': {'stop_reason': 'end_turn'}}, {'type': 'user'}]
        self.assertNotEqual(monitor.claude_state(events, True, 100, 101), '本轮已结束')

    def test_lsof_multiple_addresses(self):
        rows = monitor.listen_records('p12\ncnode\nf4\nn127.0.0.1:3000\nf5\nn[::1]:3000\np13\ncPython\nn*:8787')
        self.assertEqual([r['pid'] for r in rows], [12, 12, 13])

    def test_truncated_and_partial_json_lines(self):
        with tempfile.TemporaryDirectory() as temp:
            p = Path(temp) / 'events'
            p.write_text(json.dumps({'large': 'x' * 100}) + '\n' + json.dumps({'type': 'user'}) + '\n{"partial":')
            self.assertEqual(monitor.tail(p, 50), [{'type': 'user'}])

    def test_render_escapes_pipes(self):
        self.assertEqual(monitor.cell('a|b\nc'), 'a\\|b c')

    def test_lsof_unicode_cwd(self):
        self.assertEqual(monitor.unescape_lsof(r'/test/\xe4\xb8\xad\xe6\x96\x87'), '/test/中文')

if __name__ == '__main__':
    unittest.main()
