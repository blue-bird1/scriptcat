from __future__ import annotations

import hashlib
import os
import shlex
import shutil
import stat
import subprocess
import tempfile
import unittest
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

from scripts.remote.provider._lock import ChromiumPatch, ProviderLock, Upstream
from scripts.remote.provider._patching import chromium_patch_preparation_script

PATCH_NAME = "provider.patch"
SERIES_NAME = "series"
STABLE_NAME = "stable.txt"
CHANGED_NAME = "changed.txt"
ADDED_NAME = "added.txt"
BASE_STABLE_CONTENT = "stable base\n"
BASE_CHANGED_CONTENT = "changed base\n"
FIRST_CHANGED_CONTENT = "changed first\n"
SECOND_CHANGED_CONTENT = "changed second\n"
ADDED_CONTENT = "added second\n"
GIT_RECORD_SEPARATOR = b"\x1d"
GIT_ARGUMENT_SEPARATOR = b"\x1c"
FORBIDDEN_READ_ONLY_GIT_COMMANDS = frozenset(
    {
        "apply",
        "checkout",
        "commit-tree",
        "fetch",
        "read-tree",
        "reset",
        "update-ref",
    }
)


@dataclass(frozen=True)
class NodeSnapshot:
    inode: int
    mode: int
    size: int
    mtime_ns: int
    content_digest: str


def snapshot_node(path: Path) -> NodeSnapshot:
    metadata = path.lstat()
    if stat.S_ISREG(metadata.st_mode):
        content = path.read_bytes()
    elif stat.S_ISLNK(metadata.st_mode):
        content = os.readlink(path).encode()
    else:
        content = b""
    return NodeSnapshot(
        inode=metadata.st_ino,
        mode=metadata.st_mode,
        size=metadata.st_size,
        mtime_ns=metadata.st_mtime_ns,
        content_digest=hashlib.sha256(content).hexdigest(),
    )


def snapshot_tree(root: Path) -> dict[str, NodeSnapshot]:
    paths = [root, *root.rglob("*")]
    return {
        path.relative_to(root).as_posix(): snapshot_node(path) for path in sorted(paths)
    }


class ProviderPatchingFixture:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.source = root / "source"
        self.checkout = root / "checkout"
        self.patches = root / "patches"
        self._run_git("init", "--quiet", "--initial-branch=main", str(self.source))
        self._run_git("-C", str(self.source), "config", "user.name", "Test User")
        self._run_git(
            "-C", str(self.source), "config", "user.email", "test@example.invalid"
        )
        self._run_git("-C", str(self.source), "config", "commit.gpgSign", "false")
        (self.source / STABLE_NAME).write_text(BASE_STABLE_CONTENT, encoding="utf-8")
        (self.source / CHANGED_NAME).write_text(BASE_CHANGED_CONTENT, encoding="utf-8")
        self._run_git("-C", str(self.source), "add", "--all")
        self._run_git("-C", str(self.source), "commit", "--quiet", "-m", "base")
        self.base = self.git_output(self.source, "rev-parse", "HEAD")
        self._run_git("clone", "--quiet", str(self.source), str(self.checkout))
        self.patches.mkdir()

    def write_patch(self, changed_content: str, *, add_file: bool) -> str:
        (self.source / CHANGED_NAME).write_text(changed_content, encoding="utf-8")
        added_path = self.source / ADDED_NAME
        if add_file:
            added_path.write_text(ADDED_CONTENT, encoding="utf-8")
            self._run_git(
                "-C", str(self.source), "add", "--intent-to-add", "--", ADDED_NAME
            )
        elif added_path.exists():
            added_path.unlink()
        patch = self._run_git(
            "-C",
            str(self.source),
            "diff",
            "--binary",
            "HEAD",
            "--",
            CHANGED_NAME,
            ADDED_NAME,
            text=False,
        ).stdout
        if not isinstance(patch, bytes):
            raise TypeError("Git patch output must be bytes")
        (self.patches / PATCH_NAME).write_bytes(patch)
        (self.patches / SERIES_NAME).write_text(f"{PATCH_NAME}\n", encoding="utf-8")
        return hashlib.sha256(patch).hexdigest()

    def activate(
        self,
        checkout: Path,
        patch_sha: str,
        *,
        environment: dict[str, str] | None = None,
    ) -> subprocess.CompletedProcess[str]:
        lock = ProviderLock(
            chromium=Upstream(
                source=str(self.source), commit=self.base, version="test"
            ),
            depot_tools=Upstream(source="unused", commit=self.base, version="test"),
            chromium_patch=ChromiumPatch(
                path=PurePosixPath("patches"), sha256=patch_sha
            ),
            digest="unused",
        )
        helpers, _ = chromium_patch_preparation_script(lock)
        command = " ".join(
            (
                "activate_chromium_patch",
                shlex.quote(str(checkout)),
                shlex.quote(str(self.source)),
                shlex.quote(self.base),
                shlex.quote(str(self.patches)),
                shlex.quote(patch_sha),
            )
        )
        completed = subprocess.run(
            ("bash", "-c", f"set -Eeuo pipefail\n{helpers}\n{command}"),
            check=False,
            text=True,
            capture_output=True,
            env=environment,
        )
        if completed.returncode != 0:
            raise AssertionError(
                f"patch activation failed\nstdout:\n{completed.stdout}"
                f"\nstderr:\n{completed.stderr}"
            )
        return completed

    def git_output(self, repository: Path, *arguments: str) -> str:
        completed = self._run_git("-C", str(repository), *arguments)
        if not isinstance(completed.stdout, str):
            raise TypeError("Git output must be text")
        return completed.stdout.strip()

    @staticmethod
    def _run_git(
        *arguments: str, text: bool = True
    ) -> subprocess.CompletedProcess[str] | subprocess.CompletedProcess[bytes]:
        return subprocess.run(
            ("git", *arguments),
            check=True,
            text=text,
            capture_output=True,
        )


class ProviderIncrementalPatchingTest(unittest.TestCase):
    def setUp(self) -> None:
        temporary_directory = tempfile.TemporaryDirectory(
            prefix="scriptcat-provider-patching."
        )
        self.addCleanup(temporary_directory.cleanup)
        self.fixture = ProviderPatchingFixture(Path(temporary_directory.name))

    def test_identical_activation_is_a_read_only_verification(self) -> None:
        patch_sha = self.fixture.write_patch(FIRST_CHANGED_CONTENT, add_file=False)
        self.fixture.activate(self.fixture.checkout, patch_sha)
        expected_head = self.fixture.git_output(
            self.fixture.checkout, "rev-parse", "HEAD"
        )
        wrapper_directory = self.fixture.root / "git-wrapper"
        wrapper_directory.mkdir()
        invocation_log = self.fixture.root / "git-invocations"
        git_wrapper = wrapper_directory / "git"
        real_git = shutil.which("git")
        if real_git is None:
            self.fail("Git executable is unavailable")
        git_wrapper.write_text(
            "#!/usr/bin/env bash\n"
            'printf \'%s\\034\' "$@" >> "$GIT_INVOCATION_LOG"\n'
            "printf '\\035' >> \"$GIT_INVOCATION_LOG\"\n"
            'exec "$REAL_GIT" "$@"\n',
            encoding="utf-8",
        )
        git_wrapper.chmod(0o755)
        environment = os.environ.copy()
        environment.update(
            {
                "GIT_INVOCATION_LOG": str(invocation_log),
                "PATH": f"{wrapper_directory}{os.pathsep}{environment['PATH']}",
                "REAL_GIT": real_git,
            }
        )
        before = snapshot_tree(self.fixture.checkout)

        self.fixture.activate(self.fixture.checkout, patch_sha, environment=environment)

        self.assertEqual(snapshot_tree(self.fixture.checkout), before)
        self.assertEqual(
            self.fixture.git_output(self.fixture.checkout, "rev-parse", "HEAD"),
            expected_head,
        )
        invocations = [
            tuple(
                argument.decode() for argument in record.split(GIT_ARGUMENT_SEPARATOR)
            )
            for record in invocation_log.read_bytes().split(GIT_RECORD_SEPARATOR)
            if record
        ]
        invoked_arguments = {
            argument for invocation in invocations for argument in invocation
        }
        self.assertTrue(invocations)
        self.assertTrue(
            FORBIDDEN_READ_ONLY_GIT_COMMANDS.isdisjoint(invoked_arguments),
            invocations,
        )

    def test_changed_patch_updates_only_diff_files_deterministically(self) -> None:
        first_sha = self.fixture.write_patch(FIRST_CHANGED_CONTENT, add_file=False)
        self.fixture.activate(self.fixture.checkout, first_sha)
        first_head = self.fixture.git_output(self.fixture.checkout, "rev-parse", "HEAD")
        stable_before = snapshot_node(self.fixture.checkout / STABLE_NAME)
        changed_before = snapshot_node(self.fixture.checkout / CHANGED_NAME)

        second_sha = self.fixture.write_patch(SECOND_CHANGED_CONTENT, add_file=True)
        self.fixture.activate(self.fixture.checkout, second_sha)

        second_head = self.fixture.git_output(
            self.fixture.checkout, "rev-parse", "HEAD"
        )
        second_tree = self.fixture.git_output(
            self.fixture.checkout, "rev-parse", "HEAD^{tree}"
        )
        self.assertNotEqual(second_head, first_head)
        self.assertEqual(
            snapshot_node(self.fixture.checkout / STABLE_NAME), stable_before
        )
        self.assertNotEqual(
            snapshot_node(self.fixture.checkout / CHANGED_NAME), changed_before
        )
        self.assertEqual(
            (self.fixture.checkout / CHANGED_NAME).read_text(encoding="utf-8"),
            SECOND_CHANGED_CONTENT,
        )
        self.assertEqual(
            (self.fixture.checkout / ADDED_NAME).read_text(encoding="utf-8"),
            ADDED_CONTENT,
        )
        self.assertEqual(
            self.fixture.git_output(self.fixture.checkout, "rev-parse", "HEAD^"),
            self.fixture.base,
        )
        self.assertEqual(
            self.fixture.git_output(self.fixture.checkout, "write-tree"), second_tree
        )
        ProviderPatchingFixture._run_git(
            "-C", str(self.fixture.checkout), "diff-index", "--quiet", "HEAD", "--"
        )
        ProviderPatchingFixture._run_git(
            "-C", str(self.fixture.checkout), "diff-files", "--quiet", "--"
        )

        expected_checkout = self.fixture.root / "expected-checkout"
        ProviderPatchingFixture._run_git(
            "clone", "--quiet", str(self.fixture.source), str(expected_checkout)
        )
        ProviderPatchingFixture._run_git(
            "-C",
            str(expected_checkout),
            "apply",
            "--index",
            str(self.fixture.patches / PATCH_NAME),
        )
        self.assertEqual(
            self.fixture.git_output(expected_checkout, "write-tree"), second_tree
        )

        second_checkout = self.fixture.root / "second-checkout"
        ProviderPatchingFixture._run_git(
            "clone", "--quiet", str(self.fixture.source), str(second_checkout)
        )
        self.fixture.activate(second_checkout, second_sha)

        self.assertEqual(
            self.fixture.git_output(second_checkout, "rev-parse", "HEAD"), second_head
        )
        self.assertEqual(
            self.fixture.git_output(second_checkout, "rev-parse", "HEAD^{tree}"),
            second_tree,
        )
        self.assertEqual(
            (second_checkout / CHANGED_NAME).read_text(encoding="utf-8"),
            SECOND_CHANGED_CONTENT,
        )
        self.assertEqual(
            (second_checkout / ADDED_NAME).read_text(encoding="utf-8"), ADDED_CONTENT
        )


if __name__ == "__main__":
    unittest.main()
