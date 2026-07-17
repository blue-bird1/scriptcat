from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from scripts.remote._common import WorkflowError
from scripts.remote._lock import load_lock, validate_mcp_submodule

GIT_AUTHOR_NAME = "ScriptCat test"
GIT_AUTHOR_EMAIL = "scriptcat-test@example.invalid"
GIT_CONFIG_USER_NAME = "user.name"
GIT_CONFIG_USER_EMAIL = "user.email"
MCP_PATH = "browser/chrome-devtools-mcp"
MCP_SOURCE = "https://example.invalid/chrome-devtools-mcp.git"


class McpSubmoduleProvenanceTest(unittest.TestCase):
    def test_accepts_matching_initialized_clean_descendant_submodule(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary_name:
            root, lock_path = self._create_repository(Path(temporary_name))

            validate_mcp_submodule(root, load_lock(lock_path))

    def test_rejects_submodule_head_that_differs_from_the_gitlink(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary_name:
            root, lock_path = self._create_repository(Path(temporary_name))
            submodule = root / MCP_PATH
            self._run(("git", "checkout", "HEAD^"), cwd=submodule)

            with self.assertRaisesRegex(WorkflowError, "uninitialized, mismatched"):
                validate_mcp_submodule(root, load_lock(lock_path))

    def _create_repository(self, temporary: Path) -> tuple[Path, Path]:
        upstream = temporary / "upstream"
        root = temporary / "root"
        self._run(("git", "init", "--initial-branch=main", str(upstream)))
        self._configure_identity(upstream)
        (upstream / "README").write_text("baseline\n", encoding="utf-8")
        self._commit_all(upstream, "baseline")
        baseline = self._output(("git", "rev-parse", "HEAD"), cwd=upstream)

        self._run(("git", "init", "--initial-branch=main", str(root)))
        self._configure_identity(root)
        (root / "README").write_text("root\n", encoding="utf-8")
        self._commit_all(root, "initial")
        self._run(
            (
                "git",
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                str(upstream),
                MCP_PATH,
            ),
            cwd=root,
        )
        submodule = root / MCP_PATH
        self._configure_identity(submodule)
        (submodule / "CUSTOM").write_text("custom\n", encoding="utf-8")
        self._commit_all(submodule, "custom")
        custom = self._output(("git", "rev-parse", "HEAD"), cwd=submodule)
        modules = root / ".gitmodules"
        modules.write_text(
            modules.read_text(encoding="utf-8").replace(str(upstream), MCP_SOURCE),
            encoding="utf-8",
        )
        self._run(("git", "add", ".gitmodules", MCP_PATH), cwd=root)
        self._run(("git", "commit", "-m", "add mcp"), cwd=root)

        lock_path = root / "mcp.lock.json"
        lock_path.write_text(
            json.dumps(
                self._lock_payload(baseline=baseline, custom=custom),
                indent=2,
                sort_keys=True,
            )
            + "\n",
            encoding="utf-8",
        )
        return root, lock_path

    def _lock_payload(self, *, baseline: str, custom: str) -> dict[str, object]:
        upstream = {
            "version": "test",
            "commit": custom,
            "source": MCP_SOURCE,
        }
        return {
            "schema_version": 2,
            "chrome_devtools_mcp": {
                **upstream,
                "upstream_source": "https://example.invalid/upstream.git",
                "upstream_commit": baseline,
            },
        }

    def _configure_identity(self, repository: Path) -> None:
        self._run(
            ("git", "config", GIT_CONFIG_USER_NAME, GIT_AUTHOR_NAME), cwd=repository
        )
        self._run(
            ("git", "config", GIT_CONFIG_USER_EMAIL, GIT_AUTHOR_EMAIL), cwd=repository
        )

    def _commit_all(self, repository: Path, message: str) -> None:
        self._run(("git", "add", "."), cwd=repository)
        self._run(("git", "commit", "-m", message), cwd=repository)

    def _output(self, command: tuple[str, ...], *, cwd: Path) -> str:
        return self._run(command, cwd=cwd).stdout.strip()

    def _run(
        self, command: tuple[str, ...], *, cwd: Path | None = None
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            command, cwd=cwd, check=True, text=True, capture_output=True
        )


if __name__ == "__main__":
    unittest.main()
