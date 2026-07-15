from __future__ import annotations

import io
import json
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest.mock import patch

from scripts.remote import doctor

REMOTE_SUCCESS_OUTPUT = "remote doctor passed: fixture\n"


class DoctorCliOutputTest(unittest.TestCase):
    @patch.object(doctor, "require_wg0")
    @patch.object(doctor, "require_commands")
    @patch.object(doctor, "remote_checked")
    def test_json_mode_keeps_stdout_machine_readable(
        self, remote_checked, require_commands, require_wg0
    ) -> None:
        remote_checked.return_value.stdout = REMOTE_SUCCESS_OUTPUT

        stdout = io.StringIO()
        stderr = io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            result = doctor.run(("--json",))

        self.assertEqual(result, 0)
        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["host"], doctor.RemoteConfig().host)
        self.assertEqual(stderr.getvalue(), REMOTE_SUCCESS_OUTPUT)
        remote_checked.assert_called_once_with(
            doctor.RemoteConfig(), doctor.REMOTE_DOCTOR, capture=True
        )
        require_commands.assert_called_once_with("ip", "ssh")
        require_wg0.assert_called_once_with()

    @patch.object(doctor, "require_wg0")
    @patch.object(doctor, "require_commands")
    @patch.object(doctor, "remote_checked")
    def test_normal_mode_preserves_remote_progress_on_stdout(
        self, remote_checked, require_commands, require_wg0
    ) -> None:
        def emit_remote_progress(*_args, **_kwargs):
            print(REMOTE_SUCCESS_OUTPUT, end="")

        remote_checked.side_effect = emit_remote_progress

        stdout = io.StringIO()
        stderr = io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            result = doctor.run(())

        self.assertEqual(result, 0)
        self.assertEqual(stdout.getvalue(), REMOTE_SUCCESS_OUTPUT)
        self.assertEqual(stderr.getvalue(), "")
        remote_checked.assert_called_once_with(
            doctor.RemoteConfig(), doctor.REMOTE_DOCTOR, capture=False
        )
        require_commands.assert_called_once_with("ip", "ssh")
        require_wg0.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
