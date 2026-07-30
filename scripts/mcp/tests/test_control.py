from __future__ import annotations

import subprocess
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
from pathlib import Path
from unittest.mock import patch

from scripts.mcp import control
from scripts.mcp._common import WorkflowError
from scripts.mcp._control import load_mcp_invocation


class McpControlTest(unittest.TestCase):
    def test_status_preserves_configured_runtime_arguments_and_output(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as name:
            root = Path(name)
            config = write_config(root)
            stdout = StringIO()
            stderr = StringIO()
            completed = subprocess.CompletedProcess(
                args=(),
                returncode=0,
                stdout='{"clientCount":0}\n',
                stderr="diagnostic\n",
            )
            with (
                patch.object(control, "repository_root", return_value=root),
                patch(
                    "scripts.mcp._control.subprocess.run",
                    return_value=completed,
                ) as run_command,
                redirect_stdout(stdout),
                redirect_stderr(stderr),
            ):
                exit_code = control.run(["--config", str(config), "status"])

            self.assertEqual(exit_code, 0)
            self.assertEqual(stdout.getvalue(), completed.stdout)
            self.assertEqual(stderr.getvalue(), completed.stderr)
            command = run_command.call_args.args[0]
            self.assertEqual(
                command,
                (
                    "node",
                    "/installed/current/mcp/bin/chrome-devtools-mcp.js",
                    "shared",
                    "status",
                    "--headless",
                    "--user-data-dir=/profile",
                ),
            )
            self.assertEqual(
                run_command.call_args.kwargs["env"][
                    "CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS"
                ],
                "1",
            )

    def test_force_is_inserted_only_for_stop(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as name:
            root = Path(name)
            config = write_config(root)
            completed = subprocess.CompletedProcess(
                args=(),
                returncode=1,
                stdout="",
                stderr="ACTIVE_CLIENTS\n",
            )
            with (
                patch.object(control, "repository_root", return_value=root),
                patch(
                    "scripts.mcp._control.subprocess.run",
                    return_value=completed,
                ) as run_command,
                redirect_stdout(StringIO()),
                redirect_stderr(StringIO()),
            ):
                exit_code = control.run(["--config", str(config), "stop", "--force"])

            self.assertEqual(exit_code, 1)
            self.assertEqual(
                run_command.call_args.args[0],
                (
                    "node",
                    "/installed/current/mcp/bin/chrome-devtools-mcp.js",
                    "shared",
                    "stop",
                    "--force",
                    "--headless",
                    "--user-data-dir=/profile",
                ),
            )

    def test_invalid_server_config_fails_before_process_start(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as name:
            config = Path(name) / "config.toml"
            config.write_text(
                "[mcp_servers.chrome-devtools-scriptcat]\n"
                'command = "node"\n'
                'args = ["entry.js", "--headless"]\n',
                encoding="utf-8",
            )

            with self.assertRaises(WorkflowError):
                load_mcp_invocation(config)

    def test_status_timeout_is_bounded_and_reported(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as name:
            root = Path(name)
            config = write_config(root)
            with (
                patch.object(control, "repository_root", return_value=root),
                patch(
                    "scripts.mcp._control.subprocess.run",
                    side_effect=subprocess.TimeoutExpired(("node",), 30),
                ),
                self.assertRaisesRegex(WorkflowError, "timed out after 30 seconds"),
            ):
                control.run(["--config", str(config), "status"])


def write_config(root: Path) -> Path:
    config = root / ".codex" / "config.toml"
    config.parent.mkdir(parents=True)
    config.write_text(
        "[mcp_servers.chrome-devtools-scriptcat]\n"
        'command = "node"\n'
        'env = { CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS = "1" }\n'
        "args = [\n"
        '  "/installed/current/mcp/bin/chrome-devtools-mcp.js",\n'
        '  "shared",\n'
        '  "--headless",\n'
        '  "--user-data-dir=/profile",\n'
        "]\n",
        encoding="utf-8",
    )
    return config


if __name__ == "__main__":
    unittest.main()
