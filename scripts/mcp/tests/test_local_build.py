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
VERSION = "1.5.0"
PNPM_STDOUT = "pnpm-progress-stdout"
PNPM_STDERR = "pnpm-progress-stderr"
NODE_HELP_STDOUT = "node-help-stdout"
NODE_HELP_STDERR = "node-help-stderr"
NODE_HELP_FAILURE = "node-help-failure-stdout"


class LocalMcpBuildTest(unittest.TestCase):
    def test_build_uses_clean_local_gitlink_and_materializes_component(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as name:
            base = Path(name)
            root, lock_path = create_parent_checkout(base)
            build_root = base / "component-store"
            fake_bin = create_fake_toolchain(base)
            environment = fake_environment(fake_bin)

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
        "printf '%s\\n' \"$FAKE_PNPM_STDOUT\"\n"
        "printf '%s\\n' \"$FAKE_PNPM_STDERR\" >&2\n"
        'case "$1" in\n'
        "  install) exit 0 ;;\n"
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
    return os.environ | {
        "PATH": f"{fake_bin}:{os.environ['PATH']}",
        "FAKE_PNPM_STDOUT": PNPM_STDOUT,
        "FAKE_PNPM_STDERR": PNPM_STDERR,
        "FAKE_NODE_HELP_STDOUT": NODE_HELP_STDOUT,
        "FAKE_NODE_HELP_STDERR": NODE_HELP_STDERR,
    }


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
