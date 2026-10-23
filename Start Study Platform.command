#!/bin/bash
cd -- "$(dirname -- "$0")" || exit 1
for study_python in /opt/homebrew/bin/python3 /usr/local/bin/python3 /usr/bin/python3; do
  if [ -x "$study_python" ] && "$study_python" -c 'import sys; sys.exit(sys.version_info < (3, 10))' 2>/dev/null; then
    "$study_python" back-end/server/serve_platform.py --open
    study_status=$?
    if [ "$study_status" -ne 0 ]; then read -r -p 'Press Enter to close.'; fi
    exit "$study_status"
  fi
done
echo 'Python 3.10 or newer is required.'
read -r -p 'Press Enter to close.'
exit 1
