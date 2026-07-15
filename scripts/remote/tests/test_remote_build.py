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
    def test_scriptcat_focus_tests_cover_managed_mcp_and_updatecheck(self) -> None:
        repository = Path(__file__).resolve().parents[3]
        script = remote_build_script(
            RemoteConfig(),
            load_lock(repository / "browser/upstreams.lock.json"),
            "0" * 40,
            "https://example.invalid/scriptcat.git",
        )

        focused_tests = (
            "pnpm test:ci -- src/app/managed_mcp.test.ts "
            "src/app/service/service_worker/regular_updatecheck.test.ts"
        )
        self.assertIn(focused_tests, script)
        self.assertLess(
            script.index(focused_tests), script.index("pnpm build:managed-mcp")
        )

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

    def test_protocol_browser_command_uses_exposed_sandbox_binary(self) -> None:
        sandbox_launcher = self._render_sandbox_launcher()
        self._require_sandbox_primitives()

        with tempfile.TemporaryDirectory() as temporary_name:
            temporary = Path(temporary_name)
            build_root = temporary / "build"
            chromium_directory = build_root / "src/src"
            browser_tests = chromium_directory / "out/Release/browser_tests"
            result_directory = temporary / "result"
            result_path = result_directory / "browser-tests.txt"
            quoted_result_path = shlex.quote(str(result_path))
            browser_tests.parent.mkdir(parents=True)
            result_directory.mkdir()
            result_directory.chmod(0o777)
            self._write_executable(
                browser_tests,
                "\n".join(
                    (
                        "#!/usr/bin/env bash",
                        "set -Eeuo pipefail",
                        'test "$(id -u)" -ne 0',
                        'test -x "${BROWSER_TESTS_BINARY:?}"',
                        'test "$BROWSER_TESTS_BINARY" = "$0"',
                        'test "$BROWSER_TESTS_BINARY" = '
                        '"$SANDBOX_BUILD_ROOT/src/src/out/Release/browser_tests"',
                        'test "$PWD" = "$SANDBOX_BUILD_ROOT/src/src"',
                        'for argument in "$@"; do',
                        '  test "$argument" != --no-sandbox',
                        "done",
                        'printf \'%s\\n%s\\n\' "$BROWSER_TESTS_BINARY" "$PWD" > '
                        + quoted_result_path,
                    )
                )
                + "\n",
            )

            protocol_command = '"$BROWSER_TESTS_BINARY" --test-launcher-bot-mode'
            harness = "\n".join(
                (
                    "#!/usr/bin/env bash",
                    "set -Eeuo pipefail",
                    f"build_root={shlex.quote(str(build_root))}",
                    "test_root=",
                    "test_session_pid=",
                    sandbox_launcher,
                    (
                        "run_browser_test_in_sandbox scriptcat-browser-tests "
                        '"$build_root/src/src" '
                        f"/usr/bin:/bin {shlex.quote(protocol_command)}"
                    ),
                    "",
                )
            )

            subprocess.run(
                ("bash", "-c", harness),
                check=True,
                cwd=temporary,
                text=True,
                capture_output=True,
            )

            sandbox_browser_tests, sandbox_chromium_directory = result_path.read_text(
                encoding="utf-8"
            ).splitlines()
            self.assertNotEqual(Path(sandbox_browser_tests), browser_tests)
            self.assertEqual(
                Path(sandbox_chromium_directory).name,
                chromium_directory.name,
            )
            self.assertFalse(Path(sandbox_browser_tests).exists())

    def test_sandbox_cleans_descendant_after_session_leader_exits(self) -> None:
        sandbox_launcher = self._render_sandbox_launcher()

        with tempfile.TemporaryDirectory() as temporary_name:
            temporary = Path(temporary_name)
            result_directory = temporary / "result"
            descendant_pid_path = result_directory / "descendant-pid"
            result_directory.mkdir()
            session_command = (
                f"sleep 120 & printf '%s\\n' \"$!\" > {descendant_pid_path}"
            )
            session_launcher = f"setsid bash -c {shlex.quote(session_command)} &"
            harness = "\n".join(
                (
                    "#!/usr/bin/env bash",
                    "set -Eeuo pipefail",
                    "test_root=",
                    "test_session_pid=",
                    "test_session_pgid=",
                    sandbox_launcher,
                    session_launcher,
                    "test_session_pgid=$!",
                    'wait "$test_session_pgid"',
                    "terminate_browser_test_process_group",
                    "",
                )
            )

            harness_result = subprocess.run(
                ("bash", "-c", harness),
                check=False,
                cwd=temporary,
                text=True,
                capture_output=True,
            )
            self.assertEqual(harness_result.returncode, 0, harness_result.stderr)

            descendant_pid = int(descendant_pid_path.read_text(encoding="utf-8"))
            process_stat_path = Path("/proc") / str(descendant_pid) / "stat"
            process_state = ""
            if process_stat_path.exists():
                process_state = process_stat_path.read_text(encoding="utf-8").rsplit(
                    ") ", maxsplit=1
                )[1][0]
            self.assertIn(process_state, ("", "Z"))

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
        function_start = script.index("browser_test_process_group_exists() {")
        launcher_start = script.index("run_browser_test_in_sandbox() {", function_start)
        function_end = script.index("\n}", launcher_start) + 2
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
