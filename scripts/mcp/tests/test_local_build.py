from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from scripts.mcp import build
from scripts.mcp._component import read_component
from scripts.mcp._identity import component_build_id
from scripts.mcp._lock import load_lock

FORK_URL = "https://example.invalid/chrome-devtools-mcp.git"
VERSION = "1.12.0"
PNPM_STDOUT = "pnpm-progress-stdout"
PNPM_STDERR = "pnpm-progress-stderr"
NODE_HELP_STDOUT = "node-help-stdout"
NODE_HELP_STDERR = "node-help-stderr"
NODE_HELP_FAILURE = "node-help-failure-stdout"
SHARED_TEST_FILE = "tests/shared-browser.test.ts"
SHARED_ENTRY_ENV = "CHROME_DEVTOOLS_MCP_SHARED_TEST_ENTRY_PATH"


class LocalMcpBuildTest(unittest.TestCase):
    def test_build_uses_clean_local_gitlink_and_materializes_component(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as name:
            base = Path(name)
            root, lock_path = create_parent_checkout(base)
            build_root = base / "component-store"
            fake_bin = create_fake_toolchain(base)
            environment = fake_environment(fake_bin)
            invocation_log = Path(environment["FAKE_INVOCATION_LOG"])

            completed = run_build_cli(root, lock_path, build_root, environment)

            lock = load_lock(lock_path)
            component_id = component_build_id(lock.digest)
            self.assertEqual(completed.returncode, 0)
            self.assertEqual(completed.stdout, f"{component_id}\n")
            self.assertIn(PNPM_STDOUT, completed.stderr)
            self.assertIn(PNPM_STDERR, completed.stderr)
            self.assertIn(NODE_HELP_STDOUT, completed.stderr)
            self.assertIn(NODE_HELP_STDERR, completed.stderr)
            component = build_root / "builds" / component_id
            manifest = read_component(component, lock)
            self.assertEqual(manifest.build_id, component_id)
            self.assertEqual(
                manifest.provenance["chrome_devtools_mcp"]["build_commit"],
                lock.mcp.commit,
            )
            invocations = invocation_log.read_text(encoding="utf-8").splitlines()
            self.assertIn("PUPPETEER_SKIP_DOWNLOAD=true", invocations)
            focused_test = next(
                invocation
                for invocation in invocations
                if invocation.startswith("node ") and "tests/cli.test.ts" in invocation
            )
            shared_test = next(
                invocation
                for invocation in invocations
                if invocation.startswith("node ") and SHARED_TEST_FILE in invocation
            )
            for invocation in (focused_test, shared_test):
                self.assertIn("LC_ALL=C.UTF-8", invocation)
                self.assertIn("LANG=C.UTF-8", invocation)
                self.assertIn(
                    f"PUPPETEER_EXECUTABLE_PATH={installed_browser(base)}",
                    invocation,
                )
            self.assertNotIn(SHARED_TEST_FILE, focused_test)
            self.assertIn(
                f"{SHARED_ENTRY_ENV}=",
                shared_test,
            )
            self.assertIn(
                "/runtime/mcp/bin/chrome-devtools-mcp.js",
                shared_test,
            )
            home = Path(environment["HOME"])
            self.assertIn(
                "CHROME_DEVTOOLS_MCP_SHARED_TEST_EXECUTABLE_PATH="
                f"{installed_browser(base)}",
                shared_test,
            )
            self.assertIn("HTTP_PROXY=http://127.0.0.1:7891", shared_test)
            self.assertIn("HTTPS_PROXY=http://127.0.0.1:7891", shared_test)
            self.assertIn(
                "CHROME_DEVTOOLS_MCP_SHARED_TEST_MANAGED_SCRIPTCAT_PATH="
                f"{managed_scriptcat(home)}",
                shared_test,
            )
            self.assertIn(
                f"CHROME_DEVTOOLS_MCP_SHARED_TEST_SCRIPTCAT_REPOSITORY_ROOT={root}",
                shared_test,
            )
            self.assertIn(
                "CHROME_DEVTOOLS_MCP_SHARED_TEST_SCRIPTCAT_EXTENSION_ID="
                f"{build.SCRIPTCAT_EXTENSION_ID}",
                shared_test,
            )
            install_index = invocations.index(
                "pnpm install --frozen-lockfile --config.node-linker=hoisted"
            )
            build_index = invocations.index("pnpm build")
            focused_index = invocations.index(focused_test)
            bundle_index = invocations.index("pnpm bundle")
            shared_index = invocations.index(shared_test)
            self.assertLess(
                install_index,
                build_index,
            )
            self.assertLess(build_index, focused_index)
            self.assertLess(focused_index, bundle_index)
            self.assertLess(bundle_index, shared_index)
            help_invocations = [
                invocation
                for invocation in invocations
                if invocation.startswith("node /")
                and "chrome-devtools-mcp.js"
                in invocation.split(" CHROME_DEVTOOLS_MCP_SHARED_TEST_ENTRY_PATH=", 1)[
                    0
                ]
            ]
            self.assertEqual(len(help_invocations), 2)
            for invocation in help_invocations:
                self.assertIn("LC_ALL=zh_CN.UTF-8", invocation)
                self.assertIn("LANG=zh_CN.UTF-8", invocation)
            self.assertNotIn(" shared ", f" {help_invocations[0]} ")
            self.assertIn(" shared --help", help_invocations[1])

    def test_prerequisite_failure_precedes_dependency_install(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as name:
            base = Path(name)
            root, lock_path = create_parent_checkout(base)
            build_root = base / "component-store"
            fake_bin = create_fake_toolchain(base)
            environment = fake_environment(fake_bin)
            managed_manifest(Path(environment["HOME"])).unlink()

            completed = run_build_cli(root, lock_path, build_root, environment)

            self.assertNotEqual(completed.returncode, 0)
            self.assertIn("managed ScriptCat manifest", completed.stderr)
            invocation_log = Path(environment["FAKE_INVOCATION_LOG"])
            self.assertFalse(invocation_log.exists())

    def test_browser_configuration_failure_precedes_dependency_install(self) -> None:
        for failure in ("missing-executable", "missing-selection"):
            with (
                self.subTest(failure=failure),
                tempfile.TemporaryDirectory(dir="/tmp") as name,
            ):
                base = Path(name)
                root, lock_path = create_parent_checkout(base)
                build_root = base / "component-store"
                fake_bin = create_fake_toolchain(base)
                environment = fake_environment(fake_bin)
                if failure == "missing-executable":
                    installed_browser(base).unlink()
                else:
                    config = root / ".codex" / "config.toml"
                    config.write_text(
                        "[mcp_servers.chrome-devtools-scriptcat]\n"
                        'command = "node"\n'
                        'args = ["runtime.js", "shared"]\n',
                        encoding="utf-8",
                    )
                    git(root, "add", ".codex/config.toml")
                    git_commit(root, "configure browser")

                completed = run_build_cli(root, lock_path, build_root, environment)

                self.assertEqual(completed.returncode, 1)
                self.assertFalse(Path(environment["FAKE_INVOCATION_LOG"]).exists())
                self.assertFalse((build_root / "builds").exists())

    def test_shared_e2e_failure_does_not_materialize_component(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as name:
            base = Path(name)
            root, lock_path = create_parent_checkout(base)
            build_root = base / "component-store"
            fake_bin = create_fake_toolchain(base)
            environment = fake_environment(fake_bin) | {
                "FAKE_NODE_SHARED_FAIL": "1",
            }

            completed = run_build_cli(root, lock_path, build_root, environment)

            self.assertNotEqual(completed.returncode, 0)
            self.assertIn(SHARED_TEST_FILE, completed.stderr)
            self.assertFalse((build_root / "builds").exists())

    def test_cached_component_must_pass_runtime_smoke(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as name:
            base = Path(name)
            root, lock_path = create_parent_checkout(base)
            build_root = base / "component-store"
            fake_bin = create_fake_toolchain(base)
            environment = fake_environment(fake_bin)
            initial = run_build_cli(root, lock_path, build_root, environment)
            self.assertEqual(initial.returncode, 0)

            failed_environment = environment | {
                "FAKE_NODE_HELP_FAIL": "1",
                "FAKE_NODE_HELP_STDOUT": NODE_HELP_FAILURE,
                "FAKE_NODE_HELP_STDERR": "",
            }
            completed = run_build_cli(root, lock_path, build_root, failed_environment)

            self.assertNotEqual(completed.returncode, 0)
            self.assertEqual(completed.stdout, "")
            self.assertIn(NODE_HELP_FAILURE, completed.stderr)


def create_parent_checkout(base: Path) -> tuple[Path, Path]:
    submodule_source = base / "mcp-source"
    initialize_repository(submodule_source)
    (submodule_source / ".gitignore").write_text(
        "build/\nnode_modules/\n", encoding="utf-8"
    )
    (submodule_source / "package.json").write_text("{}\n", encoding="utf-8")
    (submodule_source / "LICENSE").write_text("license\n", encoding="utf-8")
    (submodule_source / "pnpm-lock.yaml").write_text(
        "lockfileVersion: '9.0'\n", encoding="utf-8"
    )
    git(submodule_source, "add", ".")
    git_commit(submodule_source, "source")
    commit = git(submodule_source, "rev-parse", "HEAD").stdout.strip()

    root = base / "parent"
    initialize_repository(root)
    git(
        root,
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        str(submodule_source),
        "browser/chrome-devtools-mcp",
    )
    modules = root / ".gitmodules"
    modules.write_text(
        modules.read_text(encoding="utf-8").replace(str(submodule_source), FORK_URL),
        encoding="utf-8",
    )
    lock_path = root / "browser/mcp.lock.json"
    lock_path.write_text(
        json.dumps(
            {
                "schema_version": 2,
                "chrome_devtools_mcp": {
                    "version": VERSION,
                    "commit": commit,
                    "source": FORK_URL,
                    "upstream_source": FORK_URL,
                    "upstream_commit": commit,
                },
            },
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )
    config = root / ".codex" / "config.toml"
    config.parent.mkdir()
    config.write_text(
        "[mcp_servers.chrome-devtools-scriptcat]\n"
        'command = "node"\n'
        'env = { HTTP_PROXY = "http://127.0.0.1:7891", '
        'HTTPS_PROXY = "http://127.0.0.1:7891" }\n'
        'args = ["runtime.js", "shared", '
        f'"--executable-path={installed_browser(base)}"]\n',
        encoding="utf-8",
    )
    git(root, "add", ".")
    git_commit(root, "parent")
    return root, lock_path


def create_fake_toolchain(base: Path) -> Path:
    fake_bin = base / "bin"
    fake_bin.mkdir()
    pnpm = fake_bin / "pnpm"
    pnpm.write_text(
        "#!/bin/sh\n"
        "set -eu\n"
        'printf \'pnpm %s\\n\' "$*" >> "$FAKE_INVOCATION_LOG"\n'
        "printf '%s\\n' \"$FAKE_PNPM_STDOUT\"\n"
        "printf '%s\\n' \"$FAKE_PNPM_STDERR\" >&2\n"
        'case "$1" in\n'
        "  install)\n"
        "    printf 'PUPPETEER_SKIP_DOWNLOAD=%s\\n' "
        '"${PUPPETEER_SKIP_DOWNLOAD:-}" >> "$FAKE_INVOCATION_LOG"\n'
        "    exit 0 ;;\n"
        "  test:no-build) shift; exec node scripts/test.js "
        '--test-skip-pattern=THIRD_PARTY_NOTICES "$@" ;;\n'
        "  build|bundle)\n"
        "    mkdir -p build/src/bin\n"
        "    printf '#!/usr/bin/env node\\n' > build/src/bin/chrome-devtools-mcp.js\n"
        "    chmod 755 build/src/bin/chrome-devtools-mcp.js ;;\n"
        "  *) exit 2 ;;\n"
        "esac\n",
        encoding="utf-8",
    )
    node = fake_bin / "node"
    node.write_text(
        "#!/bin/sh\n"
        "set -eu\n"
        "{\n"
        "  printf 'node %s' \"$*\"\n"
        "  printf ' CHROME_DEVTOOLS_MCP_SHARED_TEST_ENTRY_PATH=%s' "
        '"${CHROME_DEVTOOLS_MCP_SHARED_TEST_ENTRY_PATH:-}"\n'
        "  printf ' CHROME_DEVTOOLS_MCP_SHARED_TEST_EXECUTABLE_PATH=%s' "
        '"${CHROME_DEVTOOLS_MCP_SHARED_TEST_EXECUTABLE_PATH:-}"\n'
        "  printf ' LC_ALL=%s' \"${LC_ALL:-}\"\n"
        "  printf ' LANG=%s' \"${LANG:-}\"\n"
        "  printf ' PUPPETEER_EXECUTABLE_PATH=%s' "
        '"${PUPPETEER_EXECUTABLE_PATH:-}"\n'
        "  printf ' HTTP_PROXY=%s' \"${HTTP_PROXY:-}\"\n"
        "  printf ' HTTPS_PROXY=%s' \"${HTTPS_PROXY:-}\"\n"
        "  printf ' CHROME_DEVTOOLS_MCP_SHARED_TEST_MANAGED_SCRIPTCAT_PATH=%s' "
        '"${CHROME_DEVTOOLS_MCP_SHARED_TEST_MANAGED_SCRIPTCAT_PATH:-}"\n'
        "  printf ' CHROME_DEVTOOLS_MCP_SHARED_TEST_SCRIPTCAT_REPOSITORY_ROOT=%s' "
        '"${CHROME_DEVTOOLS_MCP_SHARED_TEST_SCRIPTCAT_REPOSITORY_ROOT:-}"\n'
        "  printf ' CHROME_DEVTOOLS_MCP_SHARED_TEST_SCRIPTCAT_EXTENSION_ID=%s\\n' "
        '"${CHROME_DEVTOOLS_MCP_SHARED_TEST_SCRIPTCAT_EXTENSION_ID:-}"\n'
        '} >> "$FAKE_INVOCATION_LOG"\n'
        'case "$*" in\n'
        f"  *{SHARED_TEST_FILE}*)\n"
        '    if [ "${FAKE_NODE_SHARED_FAIL:-0}" = 1 ]; then\n'
        f"      printf '%s\\n' '{SHARED_TEST_FILE} failed' >&2\n"
        "      exit 8\n"
        "    fi ;;\n"
        "esac\n"
        'for argument in "$@"; do\n'
        '  if [ "$argument" = --help ]; then\n'
        "    printf '%s\\n' \"$FAKE_NODE_HELP_STDOUT\"\n"
        '    if [ -n "$FAKE_NODE_HELP_STDERR" ]; then\n'
        "      printf '%s\\n' \"$FAKE_NODE_HELP_STDERR\" >&2\n"
        "    fi\n"
        '    if [ "${FAKE_NODE_HELP_FAIL:-0}" = 1 ]; then exit 9; fi\n'
        "  fi\n"
        "done\n"
        "exit 0\n",
        encoding="utf-8",
    )
    pnpm.chmod(0o755)
    node.chmod(0o755)
    return fake_bin


def fake_environment(fake_bin: Path) -> dict[str, str]:
    home = fake_bin.parent / "home"
    create_shared_prerequisites(home)
    return os.environ | {
        "HOME": str(home),
        "LC_ALL": "zh_CN.UTF-8",
        "LANG": "zh_CN.UTF-8",
        "PUPPETEER_SKIP_DOWNLOAD": "false",
        "HTTP_PROXY": "http://unused.invalid",
        "HTTPS_PROXY": "http://unused.invalid",
        "PATH": f"{fake_bin}:{os.environ['PATH']}",
        "FAKE_PNPM_STDOUT": PNPM_STDOUT,
        "FAKE_PNPM_STDERR": PNPM_STDERR,
        "FAKE_NODE_HELP_STDOUT": NODE_HELP_STDOUT,
        "FAKE_NODE_HELP_STDERR": NODE_HELP_STDERR,
        "FAKE_INVOCATION_LOG": str(fake_bin.parent / "invocations.log"),
    }


def create_shared_prerequisites(home: Path) -> None:
    executable = installed_browser(home.parent)
    executable.parent.mkdir(parents=True)
    executable.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    executable.chmod(0o755)
    managed = managed_scriptcat(home)
    managed.mkdir(parents=True)
    managed_manifest(home).write_text(
        '{"manifest_version": 3, "name": "ScriptCat"}\n',
        encoding="utf-8",
    )


def installed_browser(base: Path) -> Path:
    return base / "installed-browser" / "chrome"


def managed_scriptcat(home: Path) -> Path:
    return home / ".local" / "share" / "scriptcat-extension" / "managed"


def managed_manifest(home: Path) -> Path:
    return managed_scriptcat(home) / "manifest.json"


def run_build_cli(
    root: Path,
    lock_path: Path,
    build_root: Path,
    environment: dict[str, str],
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        (
            sys.executable,
            str(Path(build.__file__).resolve()),
            "--lock",
            str(lock_path),
            "--build-root",
            str(build_root),
        ),
        cwd=root,
        env=environment,
        text=True,
        capture_output=True,
        check=False,
    )


def initialize_repository(path: Path) -> None:
    path.mkdir()
    subprocess.run(("git", "init", "-q", "-b", "main"), cwd=path, check=True)


def git(root: Path, *arguments: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ("git", *arguments),
        cwd=root,
        check=True,
        text=True,
        capture_output=True,
    )


def git_commit(root: Path, message: str) -> None:
    git(
        root,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-q",
        "-m",
        message,
    )


if __name__ == "__main__":
    unittest.main()
