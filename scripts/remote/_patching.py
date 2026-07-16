from __future__ import annotations

from ._common import shell_quote
from ._lock import UpstreamLock


def patch_preparation_script(lock: UpstreamLock) -> tuple[str, str]:
    """Render content-addressed patch preparation for remote source checkouts."""
    sources = {
        "chromium": (
            "$build_root/src/src",
            lock.chromium.source,
            lock.chromium.commit,
        ),
        "scriptcat": (
            "$build_root/src/scriptcat",
            lock.scriptcat.source,
            lock.scriptcat.commit,
        ),
    }
    commands = []
    for stack in lock.patch_stacks:
        destination, source, commit = sources[stack.target]
        commands.append(
            "activate_patch_stack "
            f"{shell_quote(stack.target)} {destination} {shell_quote(source)} "
            f'{shell_quote(commit)} "$checkout"/{shell_quote(stack.path.as_posix())} '
            f"{shell_quote(stack.sha256)}"
        )
    helpers = """\
patch_schema='scriptcat-mcp-patch-stack-v1'

ensure_source_checkout() {
  local destination="$1" source="$2"
  if [ ! -d "$destination/.git" ]; then
    if [ -e "$destination" ] && \\
      [ -n "$(find "$destination" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
      printf 'refusing to replace unknown non-empty source destination: %s\\n' \\
        "$destination" >&2
      exit 76
    fi
    git clone --filter=blob:none "$source" "$destination"
  fi
}

checkout_has_no_in_progress_operation() {
  local destination="$1" git_path
  for git_path in rebase-apply rebase-merge MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD; do
    test ! -e "$(git -C "$destination" rev-parse --git-path "$git_path")" || return 1
  done
}

checkout_is_clean() {
  local destination="$1"
  checkout_has_no_in_progress_operation "$destination" || return 1
  git -C "$destination" diff --quiet || return 1
  git -C "$destination" diff --cached --quiet || return 1
  test -z "$(git -C "$destination" ls-files --others --exclude-standard)"
}

load_patch_series() {
  local patches="$1"
  local -n loaded_names="$2" loaded_files="$3"
  local patch_name patch_path
  declare -A seen_names=()
  test -d "$patches"
  test -f "$patches/series"
  mapfile -t loaded_names < <(sed -e '/^[[:space:]]*#/d' \\
    -e '/^[[:space:]]*$/d' "$patches/series")
  test "${#loaded_names[@]}" -gt 0
  for patch_name in "${loaded_names[@]}"; do
    case "$patch_name" in
      *.patch) ;;
      *) printf 'invalid patch series entry: %s\\n' "$patch_name" >&2; return 1 ;;
    esac
    test "$patch_name" = "${patch_name##*/}" || return 1
    test -z "${seen_names[$patch_name]+present}" || return 1
    seen_names[$patch_name]=1
    patch_path="$patches/$patch_name"
    test -f "$patch_path" && test ! -L "$patch_path" || return 1
    loaded_files+=("$patch_path")
  done
  test -z "$(find "$patches" -maxdepth 1 -name '*.patch' ! -type f -print -quit)" || \\
    return 1
  test "$(find "$patches" -maxdepth 1 -type f -name '*.patch' | wc -l)" \\
    -eq "${#loaded_files[@]}"
}

patch_manifest_digest() {
  local -n series_names="$1" series_files="$2"
  local manifest_file patch_index patch_name patch_file patch_length digest
  manifest_file=$(mktemp "$build_root/.patch-manifest.XXXXXX") || return 1
  for patch_index in "${!series_names[@]}"; do
    patch_name="${series_names[$patch_index]}"
    patch_file="${series_files[$patch_index]}"
    patch_length=$(wc -c < "$patch_file") || { rm -f "$manifest_file"; return 1; }
    printf '%s\\0%s\\0' "$patch_name" "$patch_length" >> "$manifest_file"
    cat "$patch_file" >> "$manifest_file"
  done
  digest=$(sha256sum "$manifest_file" | awk '{print $1}')
  rm -f "$manifest_file"
  printf '%s' "$digest"
}

expected_patch_tree() {
  local destination="$1" base="$2"
  shift 2
  local temporary_index expected_tree
  temporary_index=$(mktemp "$build_root/.patch-index.XXXXXX") || return 1
  if ! GIT_INDEX_FILE="$temporary_index" \\
    git -C "$destination" read-tree "$base^{tree}"; then
    rm -f "$temporary_index"
    return 1
  fi
  for patch_file in "$@"; do
    if ! GIT_INDEX_FILE="$temporary_index" \\
      git -C "$destination" apply --cached "$patch_file"; then
      rm -f "$temporary_index"
      return 1
    fi
  done
  expected_tree=$(GIT_INDEX_FILE="$temporary_index" \\
    git -C "$destination" write-tree) || {
    rm -f "$temporary_index"
    return 1
  }
  rm -f "$temporary_index"
  printf '%s' "$expected_tree"
}

deterministic_patch_commit() {
  local destination="$1" expected_tree="$2" base="$3" signature="$4"
  GIT_AUTHOR_NAME='ScriptCat MCP' \\
  GIT_AUTHOR_EMAIL='scriptcat-mcp@localhost' \\
  GIT_AUTHOR_DATE='1970-01-01T00:00:00+0000' \\
  GIT_COMMITTER_NAME='ScriptCat MCP' \\
  GIT_COMMITTER_EMAIL='scriptcat-mcp@localhost' \\
  GIT_COMMITTER_DATE='1970-01-01T00:00:00+0000' \\
    git -C "$destination" commit-tree "$expected_tree" -p "$base" <<EOF
ScriptCat MCP patch stack

signature: $signature
EOF
}

verify_patch_ref() {
  local destination="$1" patch_ref="$2" desired_commit="$3"
  local expected_tree="$4" base="$5" signature="$6"
  test "$(git -C "$destination" rev-parse "$patch_ref")" = "$desired_commit" || return 1
  test "$(git -C "$destination" rev-parse "$patch_ref^{tree}")" = "$expected_tree" || \\
    return 1
  test "$(git -C "$destination" rev-parse "$patch_ref^")" = "$base" || return 1
  git -C "$destination" log -1 --format=%B "$patch_ref" | \\
    grep -Fx "signature: $signature" >/dev/null
}

ensure_patch_ref() {
  local destination="$1" patch_ref="$2" desired_commit="$3"
  local expected_tree="$4" base="$5" signature="$6"
  local null_oid='0000000000000000000000000000000000000000'
  if git -C "$destination" show-ref --verify --quiet "$patch_ref"; then
    verify_patch_ref "$destination" "$patch_ref" "$desired_commit" \\
      "$expected_tree" "$base" "$signature"
    return
  fi
  if ! git -C "$destination" update-ref "$patch_ref" "$desired_commit" "$null_oid"; then
    verify_patch_ref "$destination" "$patch_ref" "$desired_commit" \\
      "$expected_tree" "$base" "$signature"
    return
  fi
  verify_patch_ref "$destination" "$patch_ref" "$desired_commit" \\
    "$expected_tree" "$base" "$signature"
}

activate_patch_stack() {
  local target="$1" destination="$2" source="$3" base="$4" patches="$5"
  local expected_patch_sha="$6"
  local -a patch_names=() patch_files=()
  local actual_patch_sha manifest_digest patch_count signature expected_tree
  local desired_commit patch_ref current_head current_tree index_tree
  load_patch_series "$patches" patch_names patch_files
  actual_patch_sha=$(cat "${patch_files[@]}" | sha256sum | awk '{print $1}')
  if test "$actual_patch_sha" != "$expected_patch_sha"; then
    printf 'patch stack checksum mismatch: target=%s expected=%s actual=%s\n' \
      "$target" "$expected_patch_sha" "$actual_patch_sha" >&2
    return 1
  fi
  manifest_digest=$(patch_manifest_digest patch_names patch_files)
  patch_count="${#patch_files[@]}"
  signature=$(printf '%s\\0' "$patch_schema" "$target" "$source" "$base" \\
    "$manifest_digest" "$patch_count" | sha256sum | awk '{print $1}')
  git -C "$destination" fetch --depth=1 "$source" "$base"
  expected_tree=$(expected_patch_tree "$destination" "$base" "${patch_files[@]}")
  desired_commit=$(deterministic_patch_commit "$destination" "$expected_tree" \\
    "$base" "$signature")
  patch_ref="refs/scriptcat-mcp/$target/$signature"
  ensure_patch_ref "$destination" "$patch_ref" "$desired_commit" \\
    "$expected_tree" "$base" "$signature"
  checkout_is_clean "$destination" || {
    printf 'refusing to activate patch ref in dirty source checkout: %s\\n' \\
      "$target" >&2
    return 1
  }
  current_head=$(git -C "$destination" rev-parse HEAD)
  if [ "$current_head" = "$desired_commit" ]; then
    printf 'reusing verified patched source: %s\\n' "$target"
    return 0
  fi
  current_tree=$(git -C "$destination" rev-parse HEAD^{tree})
  index_tree=$(git -C "$destination" write-tree)
  if [ "$current_tree" = "$expected_tree" ] && \\
    [ "$index_tree" = "$expected_tree" ]; then
    git -C "$destination" reset --soft "$desired_commit"
    printf 'adopted verified patched source without rewriting files: %s\\n' "$target"
    return 0
  fi
  git -C "$destination" checkout --detach "$desired_commit"
  printf 'activated verified patched source: %s\\n' "$target"
}
"""
    return helpers, "\n".join(commands)
