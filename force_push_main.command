#!/bin/bash

set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

printf '%s\n' \
  '警告：此脚本将本地 main 直接强制推送到 GitHub 的 origin/main，不创建 PR。' \
  '远端 main 中本地没有的提交可能被覆盖。' \
  '只推送已经提交到本地 main 的内容；不会自动提交未保存改动。' \
  ''
read -r -p '输入 confirm 才会执行，其他输入均取消：' confirmation

if [[ "$confirmation" != 'confirm' ]]; then
  printf '%s\n' '已取消，未推送。'
  exit 0
fi

if git push --force origin refs/heads/main:refs/heads/main; then
  printf '\n%s\n' '已将本地 main 推送到 origin/main。'
else
  push_status=$?
  printf '\n%s\n' '推送失败，请查看上方错误信息。'
  read -r -p '按回车关闭窗口。' _ || true
  exit "$push_status"
fi

read -r -p '按回车关闭窗口。' _ || true
