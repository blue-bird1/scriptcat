#!/usr/bin/env -S uv run python
from __future__ import annotations

import argparse
import base64
import binascii
import fcntl
import hashlib
import json
import os
import shutil
import subprocess
import sys
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from scriptcat._activation import activate_release
    from scriptcat._errors import PublishError
    from scriptcat._release import (
        Release,
        component_id,
        create_release,
        materialize_release,
    )
else:
    from ._activation import activate_release
    from ._errors import PublishError
    from ._release import Release, component_id, create_release, materialize_release

DEFAULT_DATA_ROOT = Path.home() / ".local" / "share" / "scriptcat-extension"
DEFAULT_EXTENSION_ROOT = (
    Path.home() / ".codex" / "chrome-extensions" / "scriptcat" / "managed"
)
DEFAULT_EXPECTED_EXTENSION_ID = "oepcbpjafionmhhelohlfhlmlaciclhc"
SOURCE_PATH = Path("browser/scriptcat")
FOCUSED_TESTS = ("src/app/service/service_worker/script_get_source.test.ts",)


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(
        formatter_class=argparse.RawDescriptionHelpFormatter,
        description="Build, verify, and atomically publish managed ScriptCat locally.",
        epilog=(
            "Requires git and pnpm. The first pnpm install may use the network and "
            "updates the submodule's ignored dependency/build caches. The command "
            "writes immutable releases and transaction state below --data-root, "
            "then replaces the managed directory at --extension-root.\n\n"
            "Example (fish):\n"
            "  uv run --project scripts --python 3.12 python "
            "scripts/scriptcat/publish.py"
        ),
    )
    result.add_argument(
        "--data-root",
        type=Path,
        default=DEFAULT_DATA_ROOT,
        help="release and transaction data root (default: %(default)s)",
    )
    result.add_argument(
        "--extension-root",
        type=Path,
        default=DEFAULT_EXTENSION_ROOT,
        help="fixed physical managed extension directory (default: %(default)s)",
    )
    result.add_argument(
        "--expected-extension-id",
        default=DEFAULT_EXPECTED_EXTENSION_ID,
        help="required Chromium extension ID (default: %(default)s)",
    )
    return result


def run(argv: Sequence[str]) -> int:
    arguments = parser().parse_args(argv)
    root = repository_root()
    source = root / SOURCE_PATH
    data_root = arguments.data_root.expanduser().resolve()
    extension_root = arguments.extension_root.expanduser().resolve()
    with publish_locks(data_root, extension_root):
        require_command("pnpm")
        parent_commit = require_clean_main(root)
        source_commit = validate_submodule(root, source)
        print(f"installing ScriptCat dependencies in {source}")
        run_checked(("pnpm", "install", "--frozen-lockfile"), source)
        print("running ScriptCat source-read contract test")
        run_checked(
            (
                "pnpm",
                "exec",
                "vitest",
                "run",
                "--no-coverage",
                "--reporter=default",
                "--reporter.summary=false",
                *FOCUSED_TESTS,
            ),
            source,
        )
        component = component_id(source_commit)
        print(f"building managed ScriptCat component {component}")
        run_checked(("pnpm", "build"), source)
        validate_checkout_unchanged(root, source, parent_commit, source_commit)
        extension = source / "dist" / "ext"
        release, extension_id = publish_built_extension(
            extension,
            source_commit,
            data_root,
            extension_root,
            arguments.expected_extension_id,
        )
    print(f"release_id={release.release_id}")
    print(f"current={data_root / 'current'}")
    print(f"managed_path={extension_root}")
    print(f"extension_id={extension_id}")
    return 0


def publish_built_extension(
    extension: Path,
    source_commit: str,
    data_root: Path,
    extension_root: Path,
    expected_extension_id: str,
) -> tuple[Release, str]:
    release = create_release(extension, source_commit)
    extension_id = chromium_extension_id(extension, extension_root)
    if extension_id != expected_extension_id:
        raise PublishError(
            "built extension ID does not match --expected-extension-id: "
            f"{extension_id} != {expected_extension_id}"
        )
    final = materialize_release(extension, release, data_root / "releases")
    activate_release(final, release, data_root, extension_root)
    return release, extension_id


def chromium_extension_id(extension: Path, stable_path: Path) -> str:
    try:
        raw = json.loads((extension / "manifest.json").read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise PublishError(f"cannot read extension manifest for ID: {error}") from error
    key = raw.get("key") if isinstance(raw, dict) else None
    if key is None:
        identity = str(stable_path.resolve()).encode()
    elif isinstance(key, str) and key:
        try:
            identity = base64.b64decode(key, validate=True)
        except (binascii.Error, ValueError) as error:
            raise PublishError(f"extension manifest key is invalid: {error}") from error
    else:
        raise PublishError("extension manifest key is invalid")
    digest = hashlib.sha256(identity).digest()[:16]
    return "".join(
        chr(ord("a") + nibble) for byte in digest for nibble in divmod(byte, 16)
    )


def repository_root() -> Path:
    completed = run_checked(("git", "rev-parse", "--show-toplevel"), Path.cwd(), True)
    return Path(completed.stdout.strip()).resolve()


def require_clean_main(root: Path) -> str:
    branch = git_output(root, "branch", "--show-current")
    if branch != "main":
        raise PublishError(f"current branch is {branch!r}; expected 'main'")
    if git_output(root, "status", "--porcelain"):
        raise PublishError(
            "local checkout is dirty; commit before publishing ScriptCat"
        )
    return git_output(root, "rev-parse", "HEAD")


def validate_checkout_unchanged(
    root: Path,
    source: Path,
    parent_commit: str,
    source_commit: str,
) -> None:
    if require_clean_main(root) != parent_commit:
        raise PublishError("parent checkout changed while building ScriptCat")
    if validate_submodule(root, source) != source_commit:
        raise PublishError("browser/scriptcat changed while building ScriptCat")


def validate_submodule(root: Path, source: Path) -> str:
    if not source.is_dir():
        raise PublishError(f"ScriptCat submodule is not initialized: {source}")
    line = git_output(root, "ls-tree", "HEAD", "--", SOURCE_PATH.as_posix())
    fields = line.split()
    if len(fields) < 3 or fields[1] != "commit":
        raise PublishError("browser/scriptcat is not a submodule in the current commit")
    expected = fields[2]
    actual = git_output(source, "rev-parse", "HEAD")
    if actual != expected:
        raise PublishError("browser/scriptcat HEAD does not match the parent gitlink")
    if git_output(source, "status", "--porcelain"):
        raise PublishError("browser/scriptcat has uncommitted changes")
    return actual


def require_command(command: str) -> None:
    if shutil.which(command) is None:
        raise PublishError(f"required command is unavailable: {command}")


def git_output(root: Path, *arguments: str) -> str:
    return run_checked(("git", *arguments), root, True).stdout.strip()


def run_checked(
    command: Sequence[str],
    cwd: Path,
    capture: bool = False,
) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            command,
            cwd=cwd,
            check=True,
            text=True,
            stdout=subprocess.PIPE if capture else None,
            stderr=subprocess.PIPE if capture else None,
        )
    except FileNotFoundError as error:
        raise PublishError(f"required command is unavailable: {command[0]}") from error
    except subprocess.CalledProcessError as error:
        detail = (
            error.stderr.strip() if error.stderr else f"exit status {error.returncode}"
        )
        raise PublishError(f"command failed: {' '.join(command)}: {detail}") from error


@contextmanager
def publish_locks(data_root: Path, extension_root: Path) -> Iterator[None]:
    data_root.mkdir(parents=True, exist_ok=True)
    extension_root.parent.mkdir(parents=True, exist_ok=True)
    lock_paths = sorted(
        {
            data_root / ".publish.lock",
            extension_root.with_name(f".{extension_root.name}-publish.lock"),
        },
        key=os.fspath,
    )
    streams = []
    try:
        for lock_path in lock_paths:
            stream = lock_path.open("a+", encoding="utf-8")
            streams.append(stream)
            try:
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise PublishError(
                    f"ScriptCat publish is already running for {lock_path}"
                ) from error
        yield
    finally:
        for stream in reversed(streams):
            try:
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)
            finally:
                stream.close()


def main(argv: Sequence[str] | None = None) -> int:
    try:
        return run(sys.argv[1:] if argv is None else argv)
    except PublishError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("error: interrupted", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
