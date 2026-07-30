from __future__ import annotations

import fcntl
import json
import tempfile
import unittest
from contextlib import AbstractContextManager
from pathlib import Path
from unittest.mock import patch

from scripts.mcp._activation import (
    ACTIVATION_LOCK_NAME,
    ActivationHandoff,
    activate_archive,
    commit_activation,
)
from scripts.mcp._activation_state import recover_activation
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

    def test_commit_success_before_committed_journal_failure_restores_old_links(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as name:
            root = Path(name)
            old = create_release_fixture(root / "old", payload=b"old\n")
            new = create_release_fixture(root / "new", payload=b"new\n")
            data_root = root / "data"
            releases = data_root / "releases"
            releases.mkdir(parents=True)
            old_installed = clone_release(
                old.release,
                releases / old.manifest.build_id,
            )
            (data_root / "current").symlink_to(old_installed)
            handoff = RecordingHandoff()

            from scripts.mcp import _activation

            real_write = _activation.write_journal
            writes = 0

            def fail_committed_journal(*args: object, **kwargs: object) -> None:
                nonlocal writes
                writes += 1
                if writes == 2:
                    raise OSError("simulated committed journal failure")
                real_write(*args, **kwargs)

            with (
                patch.object(
                    _activation,
                    "write_journal",
                    side_effect=fail_committed_journal,
                ),
                self.assertRaisesRegex(
                    OSError,
                    "simulated committed journal failure",
                ),
            ):
                commit_activation(
                    new.release,
                    new.manifest,
                    data_root,
                    handoff_factory=lambda _: handoff,
                )

            self.assertTrue(handoff.committed)
            self.assertFalse(handoff.aborted)
            self.assertEqual((data_root / "current").resolve(), old_installed)
            self.assertFalse((data_root / "activation-journal.json").exists())

    def test_committed_journal_recovery_preserves_new_links(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as name:
            root = Path(name)
            old = create_release_fixture(root / "old", payload=b"old\n")
            new = create_release_fixture(root / "new", payload=b"new\n")
            data_root = root / "data"
            releases = data_root / "releases"
            releases.mkdir(parents=True)
            old_installed = clone_release(
                old.release,
                releases / old.manifest.build_id,
            )
            (data_root / "current").symlink_to(old_installed)
            handoff = RecordingHandoff()

            with (
                patch(
                    "scripts.mcp._activation.remove_journal",
                    side_effect=OSError("simulated journal cleanup failure"),
                ),
                self.assertRaisesRegex(
                    OSError,
                    "simulated journal cleanup failure",
                ),
            ):
                commit_activation(
                    new.release,
                    new.manifest,
                    data_root,
                    handoff_factory=lambda _: handoff,
                )

            expected = (
                str(releases / new.manifest.build_id),
                str(old_installed),
            )
            self.assertTrue(handoff.committed)
            self.assertEqual(link_targets(data_root), expected)
            self.assertTrue((data_root / "activation-journal.json").exists())

            recover_activation(data_root)

            self.assertEqual(link_targets(data_root), expected)
            self.assertFalse((data_root / "activation-journal.json").exists())

    def test_schema_two_journal_recovers_as_uncommitted_switch(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as name:
            root = Path(name)
            old = create_release_fixture(root / "old", payload=b"old\n")
            new = create_release_fixture(root / "new", payload=b"new\n")
            data_root = root / "data"
            releases = data_root / "releases"
            releases.mkdir(parents=True)
            old_installed = clone_release(
                old.release,
                releases / old.manifest.build_id,
            )
            new_installed = clone_release(
                new.release,
                releases / new.manifest.build_id,
            )
            (data_root / "current").symlink_to(new_installed)
            (data_root / "previous").symlink_to(old_installed)
            (data_root / "activation-journal.json").write_text(
                json.dumps(
                    {
                        "schema_version": 2,
                        "build_id": new.manifest.build_id,
                        "current": {
                            "exists": True,
                            "target": str(old_installed),
                        },
                        "previous": {"exists": False, "target": None},
                    }
                )
                + "\n",
                encoding="utf-8",
            )

            recover_activation(data_root)

            self.assertEqual(
                link_targets(data_root),
                (str(old_installed), None),
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


class RecordingHandoff(AbstractContextManager[ActivationHandoff]):
    def __init__(self) -> None:
        self.committed = False
        self.aborted = False

    def __enter__(self) -> RecordingHandoff:
        return self

    def commit(self) -> None:
        self.committed = True

    def __exit__(
        self,
        error_type: type[BaseException] | None,
        error: BaseException | None,
        traceback: object,
    ) -> None:
        del error, traceback
        if error_type is not None and not self.committed:
            self.aborted = True


if __name__ == "__main__":
    unittest.main()
