#!/usr/bin/env -S uv run python
from __future__ import annotations

import argparse
import logging
import shlex
import shutil
import subprocess
import sys
import tempfile
from collections.abc import Sequence
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from mcp._common import (
        WorkflowError,
        cli_main,
        exclusive_lock,
        git_output,
        local_build_root,
        repository_root,
        require_clean_main,
        require_commands,
    )
    from mcp._component import materialize_component, read_component
    from mcp._identity import component_build_id
    from mcp._lock import UpstreamLock, load_lock, validate_mcp_submodule
else:
    from ._common import (
        WorkflowError,
        cli_main,
        exclusive_lock,
        git_output,
        local_build_root,
        repository_root,
        require_clean_main,
        require_commands,
    )
    from ._component import materialize_component, read_component
    from ._identity import component_build_id
    from ._lock import UpstreamLock, load_lock, validate_mcp_submodule

LOCK_PATH = Path("browser/mcp.lock.json")
LOGGER = logging.getLogger("scriptcat.mcp")


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(
        description="Build and focus-test the local MCP component.",
        epilog=(
            "Requires a clean main checkout and an initialized, clean MCP submodule. "
            "Installs frozen pnpm dependencies and runs the build, focused tests, and "
            "bundle in browser/chrome-devtools-mcp. It then smoke-tests the bundled "
            "CLI and stores only the verified component under the local build root. "
            "Relative --lock and --build-root paths resolve from the repository root. "
            f"The default build root is {local_build_root()}. Build progress is "
            "written to stderr; stdout contains only the component build ID for "
            "shell command substitution. No remote build host is contacted; pnpm "
            "may use its configured package registry.\n\nExample:\n  uv run "
            "--project scripts --python 3.12 python scripts/mcp/build.py"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    result.add_argument(
        "--lock",
        type=Path,
        default=LOCK_PATH,
        metavar="PATH",
        help=f"MCP supply-chain lock (default: {LOCK_PATH})",
    )
    result.add_argument(
        "--build-root",
        type=Path,
        default=local_build_root(),
        metavar="PATH",
        help=f"verified component store (default: {local_build_root()})",
    )
    return result


def run(argv: Sequence[str]) -> int:
    arguments = parser().parse_args(argv)
    require_commands("git", "node", "pnpm")
    root = repository_root()
    require_clean_main(root)
    lock = load_lock(resolve(root, arguments.lock))
    validate_mcp_submodule(root, lock)
    build_root = resolve(root, arguments.build_root)
    build_id = component_build_id(lock.digest)
    with exclusive_lock(build_root, ".build.lock"):
        existing = build_root / "builds" / build_id
        if existing.exists() or existing.is_symlink():
            read_component(existing, lock)
            smoke_runtime(existing / "runtime" / "mcp")
            LOGGER.info("reusing verified MCP component: %s", build_id)
        else:
            build_component(root, build_root, lock)
    print(build_id)
    return 0


def build_component(root: Path, build_root: Path, lock: UpstreamLock) -> None:
    checkout = root / "browser" / "chrome-devtools-mcp"
    LOGGER.info("installing frozen MCP dependencies")
    run_build_command(
        ("pnpm", "install", "--frozen-lockfile", "--config.node-linker=hoisted"),
        cwd=checkout,
    )
    LOGGER.info("building MCP sources")
    run_build_command(("pnpm", "build"), cwd=checkout)
    LOGGER.info("running focused MCP tests")
    run_build_command(
        (
            "node",
            "scripts/test.mjs",
            "--",
            "tests/cli.test.ts",
            "tests/shutdown.test.ts",
        ),
        cwd=checkout,
    )
    LOGGER.info("bundling MCP runtime")
    run_build_command(("pnpm", "bundle"), cwd=checkout)
    epoch = int(git_output(checkout, "show", "-s", "--format=%ct", "HEAD"))
    with tempfile.TemporaryDirectory(dir="/tmp", prefix="scriptcat-mcp-build-") as name:
        runtime = Path(name) / "runtime" / "mcp"
        shutil.copytree(checkout / "build" / "src", runtime, copy_function=shutil.copy2)
        shutil.copy2(checkout / "package.json", runtime / "package.json")
        shutil.copy2(checkout / "LICENSE", runtime / "LICENSE")
        smoke_runtime(runtime)
        materialize_component(runtime.parent, build_root / "builds", lock, epoch)


def run_build_command(command: Sequence[str], *, cwd: Path) -> None:
    try:
        subprocess.run(
            command,
            cwd=cwd,
            check=True,
            text=True,
            stdout=sys.stderr,
            stderr=sys.stderr,
        )
    except OSError as error:
        raise WorkflowError(f"{shlex.join(command)}: {error}") from error
    except subprocess.CalledProcessError as error:
        raise WorkflowError(
            f"{shlex.join(command)}: exited with status {error.returncode}"
        ) from error


def smoke_runtime(runtime: Path) -> None:
    LOGGER.info("smoke-testing bundled MCP CLI: %s", runtime)
    run_build_command(
        ("node", str(runtime / "bin" / "chrome-devtools-mcp.js"), "--help"),
        cwd=runtime,
    )


def resolve(root: Path, path: Path) -> Path:
    expanded = path.expanduser()
    return expanded if expanded.is_absolute() else root / expanded


if __name__ == "__main__":
    raise SystemExit(cli_main(run))
