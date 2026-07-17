from __future__ import annotations

import fcntl
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts.mcp._activation import (
    ACTIVATION_LOCK_NAME,
    activate_archive,
    commit_activation,
)
from scripts.mcp._common import WorkflowError
from scripts.mcp.tests._fixtures import (
    MCP_VERSION,
    ReleaseFixture,
    clone_release,
    create_release_fixture,
    link_targets,
)


class ActivationRecoveryTest(unittest.TestCase):
    def test_retry_after_interruption_restores_prior_links_before_activation(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as name:
            root = Path(name)
            old = create_release_fixture(root / "old", payload=b"old\n")
            older = create_release_fixture(root / "older", payload=b"older\n")
            new = create_release_fixture(root / "new", payload=b"new\n")
            data_root = root / "data"
            releases = data_root / "releases"
            releases.mkdir(parents=True)
            old_installed = clone_release(old.release, releases / old.manifest.build_id)
            older_installed = clone_release(
                older.release, releases / older.manifest.build_id
            )
            (data_root / "current").symlink_to(old_installed)
            (data_root / "previous").symlink_to(older_installed)

            from scripts.mcp import _activation

            real_replace = _activation.replace_symlink
            calls = 0

            def interrupt_second_link(path: Path, target: str) -> None:
                nonlocal calls
                calls += 1
                if calls == 2:
                    raise OSError("simulated interruption")
                real_replace(path, target)

            with (
                patch.object(
                    _activation, "replace_symlink", side_effect=interrupt_second_link
                ),
                self.assertRaises(OSError),
            ):
                commit_activation(new.release, new.manifest, data_root)

            activated = commit_activation(new.release, new.manifest, data_root)

            self.assertEqual(activated, new.manifest.build_id)
            self.assertEqual(
                link_targets(data_root),
                (str(releases / new.manifest.build_id), str(old_installed)),
            )

    def test_activation_lock_conflict_preserves_links(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as name:
            root = Path(name)
            fixture = create_release_fixture(root / "product")
            data_root = root / "data"
            data_root.mkdir()
            before = link_targets(data_root)
            lock_path = data_root / ACTIVATION_LOCK_NAME
            with lock_path.open("a+", encoding="utf-8") as lock:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                with self.assertRaises(WorkflowError):
                    activate_archive(
                        fixture.archive,
                        data_root,
                        fixture.manifest.build_id,
                        MCP_VERSION,
                        fixture.lock_digest,
                        expected_archive_sha256=fixture.archive_digest,
                        expected_source_provenance=fixture.manifest.provenance,
                    )

            self.assertEqual(link_targets(data_root), before)

    def test_repeated_activation_is_idempotent(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as name:
            root = Path(name)
            fixture = create_release_fixture(root / "product")
            data_root = root / "data"
            first = activate_fixture(fixture, data_root)
            links = link_targets(data_root)

            second = activate_fixture(fixture, data_root)

            self.assertEqual((first, second), (fixture.manifest.build_id,) * 2)
            self.assertEqual(link_targets(data_root), links)
            self.assertIsNone(links[1])

    def test_activation_replaces_residual_release_staging(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as name:
            root = Path(name)
            fixture = create_release_fixture(root / "product")
            data_root = root / "data"
            residual = data_root / "releases" / f".{fixture.manifest.build_id}-new"
            residual.mkdir(parents=True)
            (residual / "partial").write_bytes(b"interrupted\n")

            activated = activate_fixture(fixture, data_root)

            self.assertEqual(activated, fixture.manifest.build_id)
            self.assertFalse(residual.exists())
            self.assertEqual(
                link_targets(data_root),
                (str(data_root / "releases" / fixture.manifest.build_id), None),
            )


def activate_fixture(fixture: ReleaseFixture, data_root: Path) -> str:
    return activate_archive(
        fixture.archive,
        data_root,
        fixture.manifest.build_id,
        MCP_VERSION,
        fixture.lock_digest,
        expected_archive_sha256=fixture.archive_digest,
        expected_source_provenance=fixture.manifest.provenance,
    )


if __name__ == "__main__":
    unittest.main()
