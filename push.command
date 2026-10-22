#!/bin/bash
# macOS: double-click to push the current committed feature branch.
# --check performs read-only checks and never pushes, fetches, or commits.
set -u
set -o pipefail

mode=push
case "${1:-}" in
  "") ;;
  --check) mode=check ;;
  *) printf '用法：双击 push.command，或运行 ./push.command --check\n' >&2; exit 2 ;;
esac
if [ "$#" -gt 1 ]; then
  printf '参数过多。只支持 --check。\n' >&2
  exit 2
fi

finish() {
  result=$?
  trap - EXIT
  if [ "$mode" = push ] && [ -t 0 ] && [ -t 1 ]; then
    printf '\n按 Enter 关闭此窗口。'
    IFS= read -r answer || true
  fi
  exit "$result"
}
trap finish EXIT

fail() { printf '\n未推送：%s\n' "$*" >&2; exit 1; }
command -v git >/dev/null 2>&1 || fail '未找到 Git，请先安装 Git / Xcode 命令行工具。'
command -v curl >/dev/null 2>&1 || fail '未找到 curl，无法检查网络。'
script_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P) || fail '无法打开脚本所在目录。'
cd -- "$script_dir" || fail '无法进入仓库。'
repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || fail '脚本所在文件夹不是 Git 仓库。'
[ "$repo_root" = "$script_dir" ] || fail '请把 push.command 放在仓库根目录。'

check_worktree() {
  branch_now=$(git symbolic-ref --quiet --short HEAD 2>/dev/null) || fail '当前处于 detached HEAD，请先切换到功能分支。'
  case "$branch_now" in main|master) fail '请使用功能分支；main / master 应通过 Pull Request 更新。' ;; esac
  git remote get-url origin >/dev/null 2>&1 || fail '未配置 origin 远端。'
  push_urls=$(git remote get-url --push --all origin 2>/dev/null) || fail '无法读取 origin 的推送地址。'
  case "$push_urls" in
    ''|*$'\n'*) fail 'origin 必须只有一个推送地址，请先核对远端配置。' ;;
  esac
  remote_now=$push_urls
  worktree_state=$(git status --porcelain --untracked-files=all) || fail '无法检查本地文件状态。'
  [ -z "$worktree_state" ] || fail '存在未提交、已暂存或未跟踪的改动。请先检查并 commit，再点击此文件。脚本不会自动加入或提交文件。'
}
check_worktree
branch=$branch_now
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
export GIT_TERMINAL_PROMPT=0
export GIT_OPTIONAL_LOCKS=0
printf '\n正在只读检查仓库访问权限和远端分支……\n'
remote_state=$(run_limited 30 git -c http.lowSpeedLimit=1 -c http.lowSpeedTime=15 \
  ls-remote --heads "$remote_url" "refs/heads/$branch" 2>/dev/null) || \
  fail '无法读取 origin（超时、登录失效或无仓库权限）。请检查网络和 GitHub 登录后重试。'
remote_commit=$(printf '%s\n' "$remote_state" | awk 'NR == 1 { print $1 }')

if [ -n "$remote_commit" ]; then
  git cat-file -e "$remote_commit^{commit}" 2>/dev/null || fail '远端有本机尚未获取的提交，请先获取并检查远端更新。'
  git merge-base --is-ancestor "$remote_commit" HEAD || fail '远端分支包含本地未整合的修改，请先同步并处理冲突。脚本不会强制覆盖。'
  pending=$(git rev-list --count "$remote_commit..HEAD") || fail '无法统计待推送提交。'
  printf '\n待推送提交：%s\n' "$pending"
  git --no-pager log --oneline --max-count=15 "$remote_commit..HEAD" || fail '无法显示提交摘要。'
else
  printf '\n远端将创建同名分支；将上传该分支的提交历史。最近的提交：\n'
  git --no-pager log --oneline --max-count=15 HEAD || fail '当前分支尚无提交。'
fi

if [ "$mode" = check ]; then
  printf '\n检查通过。此模式没有推送、获取、提交或修改远端。\n'
  exit 0
fi

# Refuse to push if files, branch, or origin changed during the checks.
check_worktree
[ "$branch_now" = "$branch" ] && [ "$remote_now" = "$remote_url" ] || fail '检查期间分支或 origin 已变化，请重新运行。'
printf '\n正在推送到 origin/%s……\n' "$branch"
git push --set-upstream origin "HEAD:refs/heads/$branch" || fail '推送失败。请检查网络、仓库写入权限及远端更新；没有自动强制覆盖。'
printf '\n推送成功：origin/%s。main 未合并；可在 GitHub 创建 Pull Request。\n' "$branch"
