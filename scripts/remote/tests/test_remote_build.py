from __future__ import annotations

import os
import pwd
import shlex
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from scripts.remote._common import RemoteConfig
from scripts.remote._lock import load_lock
from scripts.remote._remote_build import remote_build_script


class McpBrowserSandboxRegressionTest(unittest.TestCase):
    def test_mcp_browser_command_runs_non_root_in_private_namespace(self) -> None:
        """Keep the root-launched ManagedBrowserShutdown failure from recurring."""
        sandbox_launcher = self._render_sandbox_launcher()
        self._require_sandbox_primitives()
        nobody = pwd.getpwnam("nobody")

        with tempfile.TemporaryDirectory() as temporary_name:
            temporary = Path(temporary_name)
            build_root = temporary / "build"
            mcp_directory = build_root / "src/chrome-devtools-mcp"
            chromium = build_root / "src/src/out/Release/chrome"
            command_directory = temporary / "commands"
            result_directory = temporary / "result"
            result_path = result_directory / "browser.txt"
            hostile_bash_env = temporary / "hostile-bash-env"
            quoted_result_path = shlex.quote(str(result_path))
            for directory in (mcp_directory, chromium.parent, command_directory):
                directory.mkdir(parents=True, exist_ok=True)
            result_directory.mkdir()
            result_directory.chmod(0o777)
            hostile_bash_env.write_text(
                ': "${PS1:?BASH_ENV leaked into the namespace shell}"\n',
                encoding="utf-8",
            )
            self._write_executable(
                chromium,
                "\n".join(
                    (
                        "#!/usr/bin/env bash",
                        "set -Eeuo pipefail",
                        'test "$(id -u)" -ne 0',
                        'for argument in "$@"; do',
                        '  test "$argument" != --no-sandbox',
                        "done",
                        'printf \'%s\\n%s\\n\' "$(id -u)" "$PWD" > '
                        + quoted_result_path,
                    )
                )
                + "\n",
            )
            self._write_executable(
                command_directory / "pnpm",
                "\n".join(
                    (
                        "#!/usr/bin/env bash",
                        "set -Eeuo pipefail",
                        'test -x "${PUPPETEER_EXECUTABLE_PATH:?}"',
                        'exec "$PUPPETEER_EXECUTABLE_PATH" "$@"',
                    )
                )
                + "\n",
            )

            command = 'PUPPETEER_EXECUTABLE_PATH="$BROWSER_BINARY" pnpm test:no-build'
            test_path = f"{command_directory}:{os.environ['PATH']}"
            harness = "\n".join(
                (
                    "#!/usr/bin/env bash",
                    "set -Eeuo pipefail",
                    f"build_root={shlex.quote(str(build_root))}",
                    "test_root=",
                    "test_session_pid=",
                    sandbox_launcher,
                    f"export BASH_ENV={shlex.quote(str(hostile_bash_env))}",
                    "run_browser_test_in_sandbox scriptcat-mcp-tests "
                    f"{shlex.quote(str(mcp_directory))} {shlex.quote(test_path)} "
                    f"{shlex.quote(command)}",
                    "",
                )
            )
            environment = os.environ | {
                "PATH": test_path,
                "PS1": "",
            }

            subprocess.run(
                ("bash", "-c", harness),
                check=True,
                cwd=temporary,
                env=environment,
                text=True,
                capture_output=True,
            )

            uid, sandbox_mcp_directory = result_path.read_text(
                encoding="utf-8"
            ).splitlines()
            self.assertEqual(uid, str(nobody.pw_uid))
            self.assertEqual(Path(sandbox_mcp_directory).name, mcp_directory.name)
            self.assertNotEqual(Path(sandbox_mcp_directory), mcp_directory)
            self.assertFalse(Path(sandbox_mcp_directory).exists())

    def _render_sandbox_launcher(self) -> str:
        repository = Path(__file__).resolve().parents[3]
        script = remote_build_script(
            RemoteConfig(),
            load_lock(repository / "browser/upstreams.lock.json"),
            "0" * 40,
            "https://example.invalid/scriptcat.git",
        )
        subprocess.run(
            ("bash", "-n"),
            check=True,
            input=script,
            text=True,
            capture_output=True,
        )
        function_start = script.index("run_browser_test_in_sandbox() {")
        function_end = script.index("\n}", function_start) + 2
        return script[function_start:function_end]

    def _require_sandbox_primitives(self) -> None:
        if os.geteuid() != 0:
            self.skipTest("private mount namespace regression requires root")
        required_commands = ("mount", "setpriv", "setsid", "unshare")
        if any(shutil.which(command) is None for command in required_commands):
            self.skipTest("private mount namespace primitives are unavailable")
        available = subprocess.run(
            ("unshare", "--mount", "--propagation", "private", "true"),
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        if available.returncode != 0:
            self.skipTest("current environment cannot create private mount namespaces")

    def _write_executable(self, path: Path, content: str) -> None:
        path.write_text(content, encoding="utf-8")
        path.chmod(0o755)


if __name__ == "__main__":
    unittest.main()
