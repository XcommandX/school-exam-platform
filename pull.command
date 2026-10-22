#!/bin/bash
# macOS: update the current branch from origin using fast-forward only.
# --check performs read-only network/ref checks; it never fetches or updates files.
set -u
set -o pipefail
export GIT_TERMINAL_PROMPT=0
export GIT_OPTIONAL_LOCKS=0

mode=pull
case "${1:-}" in
  "") ;;
  --check) mode=check ;;
  *) printf '用法：双击 pull.command，或运行 ./pull.command --check\n' >&2; exit 2 ;;
esac
if [ "$#" -gt 1 ]; then
  printf '参数过多。只支持 --check。\n' >&2
  exit 2
fi
finish() {
  result=$?
  trap - EXIT
  if [ "$mode" = pull ] && [ -t 0 ] && [ -t 1 ]; then
    printf '\n按 Enter 关闭此窗口。'
    IFS= read -r answer || true
  fi
  exit "$result"
}
trap finish EXIT
fail() { printf '\n未更新本地代码：%s\n' "$*" >&2; exit 1; }
command -v git >/dev/null 2>&1 || fail '未找到 Git，请先安装 Git / Xcode 命令行工具。'
command -v curl >/dev/null 2>&1 || fail '未找到 curl，无法检查网络。'
script_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P) || fail '无法打开脚本所在目录。'
cd -- "$script_dir" || fail '无法进入仓库。'
repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || fail '脚本所在文件夹不是 Git 仓库。'
[ "$repo_root" = "$script_dir" ] || fail '请把 pull.command 放在仓库根目录。'

check_worktree() {
  branch_now=$(git symbolic-ref --quiet --short HEAD 2>/dev/null) || fail '当前处于 detached HEAD，请先切换到要更新的分支。'
  head_now=$(git rev-parse --verify HEAD 2>/dev/null) || fail '当前分支尚无提交。'
  for marker in MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD rebase-merge rebase-apply sequencer BISECT_LOG; do
    operation_path=$(git rev-parse --git-path "$marker") || fail '无法检查进行中的 Git 操作。'
    [ ! -e "$operation_path" ] || fail '当前有尚未结束的合并、rebase、cherry-pick、revert 或 bisect，请先完成或退出该操作。'
  done
  remote_now=$(git remote get-url origin 2>/dev/null) || fail '未配置 origin 远端。'
  [ -n "$remote_now" ] || fail 'origin 地址为空。'
  tracking_remote=$(git config --get "branch.$branch_now.remote" 2>/dev/null) || tracking_remote=''
  tracking_merge=$(git config --get-all "branch.$branch_now.merge" 2>/dev/null) || tracking_merge=''
  if [ -n "$tracking_remote$tracking_merge" ]; then
    [ "$tracking_remote" = origin ] && [ "$tracking_merge" = "refs/heads/$branch_now" ] || \
      fail '当前分支的 upstream 不是 origin 的同名分支，请先核对跟踪设置。脚本不会改用其他分支。'
  fi
  worktree_state=$(git status --porcelain --untracked-files=all) || fail '无法检查本地文件状态。'
  [ -z "$worktree_state" ] || fail '存在未提交、已暂存或未跟踪的改动。请先保存并 commit，再拉取；脚本不会自动 stash、提交或覆盖文件。'
}
check_worktree
branch=$branch_now
local_commit=$head_now
remote_url=$remote_now

# Hide URL credentials and query strings when showing the destination.
display_url=${remote_url%%\?*}
case "$display_url" in
  *://*)
    scheme=${display_url%%://*}
    rest=${display_url#*://}
    authority=${rest%%/*}
    case "$authority" in *@*) display_url="$scheme://${authority##*@}/${rest#*/}" ;; esac
    ;;
esac
printf '仓库：%s\n分支：%s\n远端：origin (%s)\n' "$script_dir" "$branch" "$display_url"

# Probe only the origin host; never forward repository credentials to curl.
case "$remote_url" in
  https://*|http://*)
    scheme=${remote_url%%://*}
    authority=${remote_url#*://}
    authority=${authority%%/*}
    authority=${authority##*@}
    probe_url="$scheme://$authority/"
    ;;
  *) fail '本脚本的代理检查适用于 HTTPS / HTTP 远端。请将 origin 配置为仓库的 HTTPS 地址后重试。' ;;
esac

probe_connection() {
  curl -q --silent --fail --head --output /dev/null \
    --connect-timeout 5 --max-time 12 "$probe_url" 2>/dev/null
}
proxy_field() {
  printf '%s\n' "$system_proxy" | awk -v key="$1" '$1 == key && $2 == ":" { print $3; exit }'
}
use_system_proxy() {
  proxy_kind=$1
  proxy_host=$(proxy_field "${proxy_kind}Proxy")
  proxy_port=$(proxy_field "${proxy_kind}Port")
  [ -n "$proxy_host" ] || return 1
  case "$proxy_port" in ''|*[!0-9]*) return 1 ;; esac
  [ "$proxy_port" -ge 1 ] && [ "$proxy_port" -le 65535 ] || return 1
  case "$proxy_host" in *:*) proxy_host="[$proxy_host]" ;; esac
  # macOS HTTP and HTTPS settings both describe an HTTP CONNECT proxy.
  export https_proxy="http://$proxy_host:$proxy_port"
  export http_proxy="$https_proxy" HTTPS_PROXY="$https_proxy" HTTP_PROXY="$https_proxy"
}

if [ -n "${https_proxy:-}${HTTPS_PROXY:-}${http_proxy:-}${HTTP_PROXY:-}${all_proxy:-}${ALL_PROXY:-}" ]; then
  # curl ignores uppercase HTTP_PROXY. Keep explicit lowercase settings first.
  if [ -z "${http_proxy:-}" ] && [ -n "${HTTP_PROXY:-}" ]; then export http_proxy="$HTTP_PROXY"; fi
  if [ -z "${https_proxy:-}${HTTPS_PROXY:-}" ] && [ -n "${http_proxy:-}" ]; then export https_proxy="$http_proxy"; fi
  printf '\n网络：使用现有环境代理（不显示代理凭据）。\n'
  probe_connection || fail '环境代理下无法连接远端。请启动代理软件，检查 HTTPS_PROXY / HTTP_PROXY，或清除过期代理后重试。'
else
  system_proxy=''
  if command -v scutil >/dev/null 2>&1; then system_proxy=$(scutil --proxy 2>/dev/null) || system_proxy=''; fi
  system_proxy_ok=false
  for proxy_kind in HTTPS HTTP; do
    if [ "$(proxy_field "${proxy_kind}Enable")" = 1 ] && use_system_proxy "$proxy_kind"; then
      printf '\n网络：检测 macOS 系统代理。\n'
      if probe_connection; then system_proxy_ok=true; break; fi
      unset https_proxy http_proxy HTTPS_PROXY HTTP_PROXY
    fi
  done
  if [ "$system_proxy_ok" = true ]; then
    printf '系统代理连接正常，仅在本次脚本进程中使用。\n'
  else
    printf '\n网络：检测直接连接。\n'
    probe_connection || fail '直连和可用的系统 HTTP / HTTPS 代理均无法连接远端。请启动代理软件并启用系统代理，或设置 HTTPS_PROXY 后重试。'
    printf '直接连接正常，本次无需代理。\n'
  fi
fi

# Bound the read-only Git connectivity/authentication check on stock macOS.
run_limited() {
  limit=$1
  shift
  "$@" &
  task_pid=$!
  ( sleep "$limit"; kill -TERM "$task_pid" 2>/dev/null ) </dev/null >/dev/null 2>&1 &
  timer_pid=$!
  wait "$task_pid"
  task_result=$?
  kill "$timer_pid" 2>/dev/null || true
  wait "$timer_pid" 2>/dev/null || true
  return "$task_result"
}
printf '\n正在只读检查 origin/%s……\n' "$branch"
remote_state=$(run_limited 30 git -c http.lowSpeedLimit=1 -c http.lowSpeedTime=15 \
  ls-remote --heads "$remote_url" "refs/heads/$branch" 2>/dev/null) || \
  fail '无法读取 origin（超时、登录失效或无仓库权限）。请检查网络和 GitHub 登录后重试。'
remote_commit=$(printf '%s\n' "$remote_state" | awk 'NR == 1 { print $1 }')
[ -n "$remote_commit" ] || fail 'origin 上没有当前同名分支。请先核对分支，或使用 push.command 发布本地分支。'

up_to_date=false
if [ "$remote_commit" = "$local_commit" ]; then
  printf '\n当前分支已是最新版本。\n'
  up_to_date=true
elif git cat-file -e "$remote_commit^{commit}" 2>/dev/null; then
  if git merge-base --is-ancestor "$local_commit" "$remote_commit"; then
    incoming=$(git rev-list --count "$local_commit..$remote_commit") || fail '无法统计远端更新。'
    printf '\n可快进更新，远端新增提交：%s\n' "$incoming"
  elif git merge-base --is-ancestor "$remote_commit" "$local_commit"; then
    printf '\n本地已包含远端全部提交，并保留本地新增提交，无需拉取。\n'
    up_to_date=true
  else
    fail '本地与远端已分叉，需要人工整合；脚本不会自动合并或 rebase。'
  fi
else
  printf '\n远端有尚未下载的提交；实际拉取时将只允许快进更新。\n'
fi

if [ "$mode" = check ]; then
  printf '\n检查通过。此模式没有 fetch、拉取、提交、推送或修改本地文件。\n'
  exit 0
fi
[ "$up_to_date" = false ] || exit 0

# Fetch first, then fast-forward to the captured commit. Protect ignored local data too.
check_worktree
[ "$branch_now" = "$branch" ] && [ "$head_now" = "$local_commit" ] && [ "$remote_now" = "$remote_url" ] || \
  fail '检查期间分支、提交或 origin 已变化，请重新运行。'
printf '\n正在获取 origin/%s 的最新提交……\n' "$branch"
git -c fetch.prune=false -c fetch.pruneTags=false \
  fetch --no-tags --no-prune --no-recurse-submodules origin "refs/heads/$branch" || \
  fail '获取远端更新失败，本地工作文件未更新。'
fetched_commit=$(git rev-parse --verify 'FETCH_HEAD^{commit}') || fail '无法确定本次获取的提交。'
check_worktree
[ "$branch_now" = "$branch" ] && [ "$head_now" = "$local_commit" ] && [ "$remote_now" = "$remote_url" ] || \
  fail '获取期间本地分支或提交已变化；远端信息已下载，本地工作文件未更新。'
git merge --ff-only --no-autostash --no-overwrite-ignore "$fetched_commit" || \
  fail '无法快进更新，或更新会覆盖本地文件。已下载远端信息，请人工检查；没有自动 rebase、stash 或强制重置。'
printf '\n拉取完成：当前 %s 分支已更新，未切换分支，也未推送。\n' "$branch"
