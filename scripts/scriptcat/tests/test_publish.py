from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path

from scripts.scriptcat._activation import (
    ActivationStage,
    activate_release,
    recover_activation,
)
from scripts.scriptcat._errors import PublishError
from scripts.scriptcat._release import (
    Release,
    create_release,
    extension_matches,
    inspect_extension,
    materialize_release,
)
from scripts.scriptcat.publish import (
    chromium_extension_id,
    publish_built_extension,
    publish_locks,
)

SOURCE_COMMIT = "1" * 40
NEXT_SOURCE_COMMIT = "2" * 40
NEWEST_SOURCE_COMMIT = "3" * 40


class PublisherTest(unittest.TestCase):
    def test_first_publish_and_repeat_are_idempotent(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary:
            root = Path(temporary)
            source = create_extension(root / "source", b"first")
            release = create_release(source, SOURCE_COMMIT)
            data_root = root / "data"
            extension_root = root / "managed"
            final = materialize_release(source, release, data_root / "releases")

            first = activate_release(final, release, data_root, extension_root)
            current = os.readlink(data_root / "current")
            second = activate_release(final, release, data_root, extension_root)

            self.assertEqual((first, second), (release.release_id,) * 2)
            self.assertEqual(os.readlink(data_root / "current"), current)
            self.assertFalse((data_root / "previous").exists())
            self.assertTrue(extension_matches(extension_root, release))

    def test_upgrade_preserves_previous_release(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary:
            root = Path(temporary)
            data_root = root / "data"
            extension_root = root / "managed"
            old = publish_fixture(
                root / "old", data_root, extension_root, SOURCE_COMMIT, b"old"
            )
            new = publish_fixture(
                root / "new", data_root, extension_root, NEXT_SOURCE_COMMIT, b"new"
            )

            self.assertEqual(
                os.readlink(data_root / "previous"),
                str((data_root / "releases" / old.release_id).resolve()),
            )
            self.assertEqual(
                os.readlink(data_root / "current"),
                str((data_root / "releases" / new.release_id).resolve()),
            )
            self.assertTrue(extension_matches(extension_root, new))

    def test_existing_release_with_conflicting_content_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary:
            root = Path(temporary)
            source = create_extension(root / "source", b"trusted")
            release = create_release(source, SOURCE_COMMIT)
            releases = root / "releases"
            final = materialize_release(source, release, releases)
            (final / "extension" / "worker.js").write_bytes(b"tampered")

            with self.assertRaises(PublishError):
                materialize_release(source, release, releases)

    def test_repeat_publish_restores_missing_managed_directory(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary:
            root = Path(temporary)
            data_root = root / "data"
            extension_root = root / "managed"
            older = publish_fixture(
                root / "older", data_root, extension_root, SOURCE_COMMIT, b"older"
            )
            current = publish_fixture(
                root / "current",
                data_root,
                extension_root,
                NEXT_SOURCE_COMMIT,
                b"current",
            )
            current_link = os.readlink(data_root / "current")
            previous_link = os.readlink(data_root / "previous")
            final = data_root / "releases" / current.release_id
            extension_root.rename(root / "missing-managed-backup")

            activate_release(final, current, data_root, extension_root)

            self.assertEqual(os.readlink(data_root / "current"), current_link)
            self.assertEqual(os.readlink(data_root / "previous"), previous_link)
            self.assertEqual(
                previous_link,
                str((data_root / "releases" / older.release_id).resolve()),
            )
            self.assertEqual(inspect_extension(extension_root), current.inventory)

    def test_repeat_publish_restores_damaged_managed_directory(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary:
            root = Path(temporary)
            data_root = root / "data"
            extension_root = root / "managed"
            older = publish_fixture(
                root / "older", data_root, extension_root, SOURCE_COMMIT, b"older"
            )
            current = publish_fixture(
                root / "current",
                data_root,
                extension_root,
                NEXT_SOURCE_COMMIT,
                b"current",
            )
            current_link = os.readlink(data_root / "current")
            previous_link = os.readlink(data_root / "previous")
            final = data_root / "releases" / current.release_id
            (extension_root / "worker.js").write_bytes(b"damaged")

            activate_release(final, current, data_root, extension_root)

            self.assertEqual(os.readlink(data_root / "current"), current_link)
            self.assertEqual(os.readlink(data_root / "previous"), previous_link)
            self.assertEqual(
                previous_link,
                str((data_root / "releases" / older.release_id).resolve()),
            )
            self.assertEqual(inspect_extension(extension_root), current.inventory)

    def test_publish_lock_serializes_shared_managed_directory(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary:
            root = Path(temporary)
            extension_root = root / "managed"

            with (
                publish_locks(root / "data-a", extension_root),
                self.assertRaises(PublishError),
                publish_locks(root / "data-b", extension_root),
            ):
                self.fail("shared managed directory was not locked")

    def test_extension_id_mismatch_has_no_publish_side_effects(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary:
            root = Path(temporary)
            source = create_extension(root / "source", b"trusted")
            data_root = root / "data"
            extension_root = root / "managed"
            mismatched_id = chromium_extension_id(source, root / "other-managed")

            with self.assertRaises(PublishError):
                publish_built_extension(
                    source,
                    SOURCE_COMMIT,
                    data_root,
                    extension_root,
                    mismatched_id,
                )

            self.assertFalse(data_root.exists())
            self.assertFalse(extension_root.exists())

    def test_recovery_does_not_remove_another_data_roots_transaction(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary:
            root = Path(temporary)
            data_root = root / "data-a"
            extension_root = root / "managed"
            old = publish_fixture(
                root / "old", data_root, extension_root, SOURCE_COMMIT, b"old"
            )
            new_source = create_extension(root / "new", b"new")
            new = create_release(new_source, NEXT_SOURCE_COMMIT)
            new_final = materialize_release(new_source, new, data_root / "releases")
            with self.assertRaises(InjectedFailure):
                activate_release(
                    new_final,
                    new,
                    data_root,
                    extension_root,
                    checkpoint=lambda stage: raise_at(
                        stage, ActivationStage.JOURNAL_WRITTEN
                    ),
                )

            recover_activation(root / "data-b", extension_root)
            recover_activation(data_root, extension_root)

            self.assertEqual(
                os.readlink(data_root / "current"),
                str((data_root / "releases" / old.release_id).resolve()),
            )
            self.assertEqual(inspect_extension(extension_root), old.inventory)
            self.assertFalse(transaction_entries(data_root, extension_root))

    def test_interrupted_publish_restores_old_release_before_retry(self) -> None:
        interrupted_stages = tuple(
            stage
            for stage in ActivationStage
            if stage is not ActivationStage.JOURNAL_REMOVED
        )
        for stage in interrupted_stages:
            with self.subTest(stage=stage):
                self._assert_interrupted_publish_recovers(stage)

    def test_interrupted_same_release_repair_recovers_on_rerun(self) -> None:
        for missing in (False, True):
            stages = tuple(
                stage
                for stage in ActivationStage
                if not missing or stage is not ActivationStage.EXTENSION_EXCHANGED
            )
            for stage in stages:
                with self.subTest(missing=missing, stage=stage):
                    self._assert_interrupted_repair_recovers(stage, missing)

    def test_interruption_after_commit_keeps_new_release(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary:
            root = Path(temporary)
            data_root = root / "data"
            extension_root = root / "managed"
            older = publish_fixture(
                root / "older", data_root, extension_root, SOURCE_COMMIT, b"older"
            )
            old = publish_fixture(
                root / "old", data_root, extension_root, NEXT_SOURCE_COMMIT, b"old"
            )
            new_source = create_extension(root / "new", b"new")
            new = create_release(new_source, NEWEST_SOURCE_COMMIT)
            new_final = materialize_release(new_source, new, data_root / "releases")

            with self.assertRaises(InjectedFailure):
                activate_release(
                    new_final,
                    new,
                    data_root,
                    extension_root,
                    checkpoint=lambda stage: raise_at(
                        stage, ActivationStage.JOURNAL_REMOVED
                    ),
                )

            recover_activation(data_root, extension_root)
            self.assertTrue(extension_matches(extension_root, new))
            self.assertEqual(os.readlink(data_root / "current"), str(new_final))
            self.assertEqual(
                os.readlink(data_root / "previous"),
                str((data_root / "releases" / old.release_id).resolve()),
            )
            self.assertNotEqual(
                os.readlink(data_root / "previous"),
                str((data_root / "releases" / older.release_id).resolve()),
            )

    def _assert_interrupted_publish_recovers(self, target: ActivationStage) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary:
            root = Path(temporary)
            data_root = root / "data"
            extension_root = root / "managed"
            older = publish_fixture(
                root / "older", data_root, extension_root, SOURCE_COMMIT, b"older"
            )
            old = publish_fixture(
                root / "old", data_root, extension_root, NEXT_SOURCE_COMMIT, b"old"
            )
            new_source = create_extension(root / "new", b"new")
            new = create_release(new_source, NEWEST_SOURCE_COMMIT)
            new_final = materialize_release(new_source, new, data_root / "releases")

            with self.assertRaises(InjectedFailure):
                activate_release(
                    new_final,
                    new,
                    data_root,
                    extension_root,
                    checkpoint=lambda stage: raise_at(stage, target),
                )

            recover_activation(data_root, extension_root)
            self.assertEqual(
                os.readlink(data_root / "current"),
                str((data_root / "releases" / old.release_id).resolve()),
            )
            self.assertEqual(
                os.readlink(data_root / "previous"),
                str((data_root / "releases" / older.release_id).resolve()),
            )
            self.assertEqual(inspect_extension(extension_root), old.inventory)
            self.assertFalse(transaction_entries(data_root, extension_root))

            activate_release(new_final, new, data_root, extension_root)
            self.assertEqual(os.readlink(data_root / "current"), str(new_final))
            self.assertEqual(
                os.readlink(data_root / "previous"),
                str((data_root / "releases" / old.release_id).resolve()),
            )
            self.assertEqual(inspect_extension(extension_root), new.inventory)

    def _assert_interrupted_repair_recovers(
        self, target: ActivationStage, missing: bool
    ) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary:
            root = Path(temporary)
            data_root = root / "data"
            extension_root = root / "managed"
            older = publish_fixture(
                root / "older", data_root, extension_root, SOURCE_COMMIT, b"older"
            )
            current = publish_fixture(
                root / "current",
                data_root,
                extension_root,
                NEXT_SOURCE_COMMIT,
                b"current",
            )
            current_link = os.readlink(data_root / "current")
            previous_link = os.readlink(data_root / "previous")
            current_final = data_root / "releases" / current.release_id
            if missing:
                extension_root.rename(root / "missing-managed-backup")
            else:
                (extension_root / "worker.js").write_bytes(b"damaged")

            with self.assertRaises(InjectedFailure):
                activate_release(
                    current_final,
                    current,
                    data_root,
                    extension_root,
                    checkpoint=lambda stage: raise_at(stage, target),
                )

            activate_release(
                current_final,
                current,
                data_root,
                extension_root,
            )

            self.assertEqual(os.readlink(data_root / "current"), current_link)
            self.assertEqual(os.readlink(data_root / "previous"), previous_link)
            self.assertEqual(
                previous_link,
                str((data_root / "releases" / older.release_id).resolve()),
            )
            self.assertEqual(inspect_extension(extension_root), current.inventory)
            self.assertFalse(transaction_entries(data_root, extension_root))


class InjectedFailure(RuntimeError):
    pass


def raise_at(stage: ActivationStage, target: ActivationStage) -> None:
    if stage is target:
        raise InjectedFailure


def publish_fixture(
    source_root: Path,
    data_root: Path,
    extension_root: Path,
    commit: str,
    worker: bytes,
) -> Release:
    source = create_extension(source_root, worker)
    release = create_release(source, commit)
    final = materialize_release(source, release, data_root / "releases")
    activate_release(final, release, data_root, extension_root)
    return release


def create_extension(root: Path, worker: bytes) -> Path:
    root.mkdir(parents=True)
    (root / "manifest.json").write_text(
        json.dumps({"manifest_version": 3, "name": "Managed", "version": "1.0.0"}),
        encoding="utf-8",
    )
    (root / "worker.js").write_bytes(worker)
    assets = root / "assets"
    assets.mkdir()
    (assets / "icon.txt").write_bytes(b"icon")
    return root


def transaction_entries(data_root: Path, extension_root: Path) -> tuple[Path, ...]:
    fixed_candidates = (
        data_root / "activation-journal.json",
        data_root / ".activation-journal-new",
    )
    extension_candidates = extension_root.parent.glob(
        f".{extension_root.name}-*-publish-*"
    )
    candidates = (*fixed_candidates, *extension_candidates)
    return tuple(path for path in candidates if path.exists() or path.is_symlink())


if __name__ == "__main__":
    unittest.main()
