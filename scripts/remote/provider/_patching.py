from __future__ import annotations

from .._common import shell_quote
from ._lock import ProviderLock


def chromium_patch_preparation_script(lock: ProviderLock) -> tuple[str, str]:
    """Render the provider-owned incremental Chromium patch activation helpers."""
    command = (
        'activate_chromium_patch "$build_root/src/src" '
        f"{shell_quote(lock.chromium.source)} {shell_quote(lock.chromium.commit)} "
        f'"$checkout"/{shell_quote(lock.chromium_patch.path.as_posix())} '
        f"{shell_quote(lock.chromium_patch.sha256)}"
    )
    helpers = r"""patch_schema='scriptcat-browser-provider-chromium-patch-v2'
patch_ref_root='refs/scriptcat-browser/provider/chromium'
bootstrap_ref='refs/scriptcat-browser/provider/bootstrap'
patch_commit_title='ScriptCat browser provider Chromium patch stack'

ensure_source_checkout() {
  local destination="$1" source="$2" cloned_head
  if [ ! -d "$destination/.git" ]; then
    if [ -e "$destination" ] && \
      [ -n "$(find "$destination" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
      printf 'refusing to replace unknown non-empty source destination: %s\n' \
        "$destination" >&2
      exit 76
    fi
    git clone --filter=blob:none "$source" "$destination"
    cloned_head=$(git -C "$destination" rev-parse HEAD)
    git -C "$destination" update-ref "$bootstrap_ref" "$cloned_head"
  fi
}

checkout_has_no_in_progress_operation() {
  local destination="$1" git_path
  for git_path in rebase-apply rebase-merge MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD; do
    test ! -e "$(git -C "$destination" rev-parse --git-path "$git_path")" || return 1
  done
}

checkout_tracked_state_is_clean() {
  local destination="$1"
  checkout_has_no_in_progress_operation "$destination" || return 1
  GIT_OPTIONAL_LOCKS=0 git -C "$destination" \
    diff-index --cached --quiet HEAD -- || return 1
  GIT_OPTIONAL_LOCKS=0 git -C "$destination" diff-files --quiet --
}

load_patch_series() {
  local patches="$1"
  local -n loaded_names="$2" loaded_files="$3"
  local patch_name patch_file
  declare -A seen_names=()
  test -d "$patches" && test -f "$patches/series"
  mapfile -t loaded_names < <(sed -e '/^[[:space:]]*#/d' \
    -e '/^[[:space:]]*$/d' "$patches/series")
  test "${#loaded_names[@]}" -gt 0
  for patch_name in "${loaded_names[@]}"; do
    case "$patch_name" in
      *.patch) ;;
      *)
        printf 'invalid Chromium patch series entry: %s\n' "$patch_name" >&2
        return 1
        ;;
    esac
    test "$patch_name" = "${patch_name##*/}" || return 1
    test -z "${seen_names[$patch_name]+present}" || return 1
    seen_names[$patch_name]=1
    patch_file="$patches/$patch_name"
    test -f "$patch_file" && test ! -L "$patch_file" || return 1
    loaded_files+=("$patch_file")
  done
  test -z "$(find "$patches" -maxdepth 1 -name '*.patch' ! -type f \
    -print -quit)" || return 1
  test "$(find "$patches" -maxdepth 1 -type f -name '*.patch' | wc -l)" \
    -eq "${#loaded_files[@]}"
}

patch_manifest_digest() {
  local -n series_names="$1" series_files="$2"
  local patch_index patch_name patch_file patch_length
  {
    for patch_index in "${!series_names[@]}"; do
      patch_name="${series_names[$patch_index]}"
      patch_file="${series_files[$patch_index]}"
      patch_length=$(wc -c < "$patch_file") || return 1
      printf '%s\0%s\0' "$patch_name" "$patch_length"
      cat "$patch_file"
    done
  } | sha256sum | awk '{print $1}'
}

patch_signature() {
  local source="$1" base="$2" manifest_digest="$3" patch_count="$4"
  local patch_sha="$5"
  printf '%s\0%s\0%s\0%s\0%s\0%s\0' "$patch_schema" "$source" "$base" \
    "$manifest_digest" "$patch_count" "$patch_sha" | sha256sum | awk '{print $1}'
}

patch_commit_message() {
  local source="$1" base="$2" manifest_digest="$3" patch_count="$4"
  local patch_sha="$5" signature="$6"
  printf '%s\n\nschema: %s\nsource: %s\nbase: %s\nmanifest: %s\n' \
    "$patch_commit_title" "$patch_schema" "$source" "$base" "$manifest_digest"
  printf 'patch-count: %s\npatch-sha256: %s\nsignature: %s\n' \
    "$patch_count" "$patch_sha" "$signature"
}

render_patch_commit_object() {
  local tree="$1" base="$2" source="$3" manifest_digest="$4" patch_count="$5"
  local patch_sha="$6" signature="$7"
  printf 'tree %s\nparent %s\n' "$tree" "$base"
  printf 'author ScriptCat browser provider <scriptcat-browser@localhost> 0 +0000\n'
  printf '%s\n\n' \
    'committer ScriptCat browser provider <scriptcat-browser@localhost> 0 +0000'
  patch_commit_message "$source" "$base" "$manifest_digest" "$patch_count" \
    "$patch_sha" "$signature"
}

create_patch_commit() {
  local destination="$1" tree="$2" base="$3" source="$4" manifest_digest="$5"
  local patch_count="$6" patch_sha="$7" signature="$8"
  patch_commit_message "$source" "$base" "$manifest_digest" "$patch_count" \
    "$patch_sha" "$signature" | \
    GIT_AUTHOR_NAME='ScriptCat browser provider' \
    GIT_AUTHOR_EMAIL='scriptcat-browser@localhost' \
    GIT_AUTHOR_DATE='1970-01-01T00:00:00+0000' \
    GIT_COMMITTER_NAME='ScriptCat browser provider' \
    GIT_COMMITTER_EMAIL='scriptcat-browser@localhost' \
    GIT_COMMITTER_DATE='1970-01-01T00:00:00+0000' \
      git -C "$destination" commit-tree "$tree" -p "$base"
}

is_lower_hex() {
  local value="$1" length="$2"
  test "${#value}" -eq "$length" || return 1
  case "$value" in
    *[!0-9a-f]*) return 1 ;;
  esac
}

load_patch_metadata() {
  local destination="$1" head="$2"
  local -n loaded_source="$3" loaded_base="$4" loaded_manifest="$5"
  local -n loaded_count="$6" loaded_patch_sha="$7" loaded_signature="$8"
  local -a lines=()
  mapfile -t lines < <(git -C "$destination" log -1 --format=%B "$head")
  test "${#lines[@]}" -eq 10 || return 1
  test "${lines[0]}" = "$patch_commit_title" && test -z "${lines[1]}" || return 1
  test "${lines[2]}" = "schema: $patch_schema" || return 1
  case "${lines[3]}" in
    source:\ *) loaded_source="${lines[3]#source: }" ;;
    *) return 1 ;;
  esac
  case "${lines[4]}" in
    base:\ *) loaded_base="${lines[4]#base: }" ;;
    *) return 1 ;;
  esac
  case "${lines[5]}" in
    manifest:\ *) loaded_manifest="${lines[5]#manifest: }" ;;
    *) return 1 ;;
  esac
  case "${lines[6]}" in
    patch-count:\ *) loaded_count="${lines[6]#patch-count: }" ;;
    *) return 1 ;;
  esac
  case "${lines[7]}" in
    patch-sha256:\ *) loaded_patch_sha="${lines[7]#patch-sha256: }" ;;
    *) return 1 ;;
  esac
  case "${lines[8]}" in
    signature:\ *) loaded_signature="${lines[8]#signature: }" ;;
    *) return 1 ;;
  esac
  test -z "${lines[9]}" && test -n "$loaded_source" || return 1
  is_lower_hex "$loaded_base" 40 && is_lower_hex "$loaded_manifest" 64 || return 1
  is_lower_hex "$loaded_patch_sha" 64 && is_lower_hex "$loaded_signature" 64 || return 1
  case "$loaded_count" in ''|0|*[!0-9]*) return 1 ;; esac
}

verify_patch_ref() {
  local destination="$1" signature="$2" head="$3"
  local patch_ref="$patch_ref_root/$signature"
  git -C "$destination" show-ref --verify --quiet "$patch_ref" || return 1
  test "$(git -C "$destination" rev-parse "$patch_ref")" = "$head"
}

verify_patch_commit() {
  local destination="$1" head="$2" tree="$3" base="$4" source="$5"
  local manifest_digest="$6" patch_count="$7" patch_sha="$8" signature="$9"
  test "$(git -C "$destination" cat-file commit "$head")" = \
    "$(render_patch_commit_object "$tree" "$base" "$source" "$manifest_digest" \
      "$patch_count" "$patch_sha" "$signature")"
}

verify_exact_patch_state() {
  local destination="$1" source="$2" base="$3" manifest_digest="$4"
  local patch_count="$5" patch_sha="$6" signature="$7"
  local head tree
  checkout_tracked_state_is_clean "$destination" || return 1
  ! git -C "$destination" symbolic-ref --quiet HEAD >/dev/null || return 1
  head=$(git -C "$destination" rev-parse HEAD) || return 1
  tree=$(git -C "$destination" rev-parse 'HEAD^{tree}') || return 1
  verify_patch_ref "$destination" "$signature" "$head" || return 1
  verify_patch_commit "$destination" "$head" "$tree" "$base" "$source" \
    "$manifest_digest" "$patch_count" "$patch_sha" "$signature"
}

verify_known_patch_state() {
  local destination="$1" expected_source="$2"
  local head tree source base manifest_digest patch_count patch_sha signature
  local calculated_signature
  checkout_tracked_state_is_clean "$destination" || return 1
  ! git -C "$destination" symbolic-ref --quiet HEAD >/dev/null || return 1
  head=$(git -C "$destination" rev-parse HEAD) || return 1
  tree=$(git -C "$destination" rev-parse 'HEAD^{tree}') || return 1
  load_patch_metadata "$destination" "$head" source base manifest_digest \
    patch_count patch_sha signature || return 1
  test "$source" = "$expected_source" || return 1
  calculated_signature=$(patch_signature "$source" "$base" "$manifest_digest" \
    "$patch_count" "$patch_sha") || return 1
  test "$calculated_signature" = "$signature" || return 1
  verify_patch_ref "$destination" "$signature" "$head" || return 1
  verify_patch_commit "$destination" "$head" "$tree" "$base" "$source" \
    "$manifest_digest" "$patch_count" "$patch_sha" "$signature"
}

render_legacy_commit_object() {
  local tree="$1" base="$2"
  printf 'tree %s\nparent %s\n' "$tree" "$base"
  printf 'author ScriptCat browser provider <scriptcat-browser@localhost> 0 +0000\n'
  printf '%s\n\n' \
    'committer ScriptCat browser provider <scriptcat-browser@localhost> 0 +0000'
  printf '%s\n' "$patch_commit_title"
}

verify_legacy_patch_state() {
  local destination="$1" head="$2" tree="$3" base="$4"
  ! git -C "$destination" symbolic-ref --quiet HEAD >/dev/null || return 1
  test "$(git -C "$destination" cat-file commit "$head")" = \
    "$(render_legacy_commit_object "$tree" "$base")"
}

expected_patch_tree() {
  local destination="$1" base="$2"
  shift 2
  local git_directory temporary_directory temporary_index expected_tree patch_file
  git_directory=$(git -C "$destination" rev-parse --absolute-git-dir) || return 1
  temporary_directory=$(mktemp -d \
    "$git_directory/scriptcat-provider-desired-index.XXXXXX") || return 1
  temporary_index="$temporary_directory/index"
  if ! GIT_INDEX_FILE="$temporary_index" git -C "$destination" \
    read-tree "$base^{tree}"; then
    rm -rf -- "$temporary_directory"
    return 1
  fi
  for patch_file in "$@"; do
    if ! GIT_INDEX_FILE="$temporary_index" git -C "$destination" \
      apply --cached "$patch_file"; then
      rm -rf -- "$temporary_directory"
      return 1
    fi
  done
  expected_tree=$(GIT_INDEX_FILE="$temporary_index" \
    git -C "$destination" write-tree) || {
      rm -rf -- "$temporary_directory"
      return 1
    }
  rm -rf -- "$temporary_directory"
  printf '%s' "$expected_tree"
}

ensure_patch_ref() {
  local destination="$1" patch_ref="$2" desired_commit="$3"
  local null_oid='0000000000000000000000000000000000000000'
  if git -C "$destination" show-ref --verify --quiet "$patch_ref"; then
    test "$(git -C "$destination" rev-parse "$patch_ref")" = "$desired_commit"
    return
  fi
  git -C "$destination" update-ref "$patch_ref" "$desired_commit" "$null_oid"
}

incremental_worktree_update() {
  local destination="$1" desired_tree="$2"
  local git_directory index_path temporary_directory transition_index index_tree
  git_directory=$(git -C "$destination" rev-parse --absolute-git-dir) || return 1
  index_path=$(git -C "$destination" rev-parse \
    --path-format=absolute --git-path index) || return 1
  test -f "$index_path" || return 1
  temporary_directory=$(mktemp -d \
    "$git_directory/scriptcat-provider-transition-index.XXXXXX") || return 1
  transition_index="$temporary_directory/index"
  if ! cp -- "$index_path" "$transition_index"; then
    rm -rf -- "$temporary_directory"
    return 1
  fi
  if ! GIT_INDEX_FILE="$transition_index" git -C "$destination" \
    read-tree --reset -u "$desired_tree"; then
    rm -rf -- "$temporary_directory"
    return 1
  fi
  index_tree=$(GIT_INDEX_FILE="$transition_index" \
    git -C "$destination" write-tree) || {
      rm -rf -- "$temporary_directory"
      return 1
    }
  if [ "$index_tree" != "$desired_tree" ] || \
    ! GIT_OPTIONAL_LOCKS=0 GIT_INDEX_FILE="$transition_index" \
      git -C "$destination" diff-files --quiet --; then
    rm -rf -- "$temporary_directory"
    return 1
  fi
  mv -- "$transition_index" "$index_path"
  rmdir -- "$temporary_directory"
}

move_detached_head() {
  local destination="$1" current_head="$2" desired_commit="$3"
  if git -C "$destination" symbolic-ref --quiet HEAD >/dev/null; then
    git -C "$destination" update-ref --no-deref HEAD "$desired_commit"
  else
    git -C "$destination" update-ref --no-deref HEAD \
      "$desired_commit" "$current_head"
  fi
}

activate_chromium_patch() {
  local destination="$1" source="$2" base="$3" patches="$4" expected_sha="$5"
  local -a patch_names=() patch_files=()
  local actual_sha manifest_digest patch_count signature current_head current_tree
  local desired_tree desired_commit patch_ref current_state
  load_patch_series "$patches" patch_names patch_files
  actual_sha=$(cat "${patch_files[@]}" | sha256sum | awk '{print $1}')
  test "$actual_sha" = "$expected_sha"
  manifest_digest=$(patch_manifest_digest patch_names patch_files)
  patch_count="${#patch_files[@]}"
  signature=$(patch_signature "$source" "$base" "$manifest_digest" \
    "$patch_count" "$actual_sha")

  if verify_exact_patch_state "$destination" "$source" "$base" \
    "$manifest_digest" "$patch_count" "$actual_sha" "$signature"; then
    return 0
  fi

  checkout_tracked_state_is_clean "$destination" || {
    printf 'refusing to replace a modified Chromium checkout: %s\n' \
      "$destination" >&2
    return 1
  }
  current_head=$(git -C "$destination" rev-parse HEAD)
  current_tree=$(git -C "$destination" rev-parse 'HEAD^{tree}')
  if [ "$current_head" = "$base" ]; then
    current_state=base
  elif verify_known_patch_state "$destination" "$source"; then
    current_state=patched
  elif verify_legacy_patch_state "$destination" "$current_head" \
    "$current_tree" "$base"; then
    current_state=legacy
  elif git -C "$destination" show-ref --verify --quiet "$bootstrap_ref" && \
    [ "$(git -C "$destination" rev-parse "$bootstrap_ref")" = "$current_head" ]; then
    current_state=bootstrap
  else
    printf 'refusing to replace an unknown Chromium checkout state: %s\n' \
      "$destination" >&2
    return 1
  fi
  test -n "$current_state"

  git -C "$destination" fetch --depth=1 "$source" "$base"
  desired_tree=$(expected_patch_tree "$destination" "$base" "${patch_files[@]}")
  desired_commit=$(create_patch_commit "$destination" "$desired_tree" "$base" \
    "$source" "$manifest_digest" "$patch_count" "$actual_sha" "$signature")
  patch_ref="$patch_ref_root/$signature"
  ensure_patch_ref "$destination" "$patch_ref" "$desired_commit"

  if [ "$current_tree" != "$desired_tree" ]; then
    incremental_worktree_update "$destination" "$desired_tree"
  fi
  move_detached_head "$destination" "$current_head" "$desired_commit"
  verify_exact_patch_state "$destination" "$source" "$base" \
    "$manifest_digest" "$patch_count" "$actual_sha" "$signature"
}
"""
    return helpers, command
