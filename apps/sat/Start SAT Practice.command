#!/bin/bash
cd -- "$(dirname -- "$0")" || exit 1
for sat_python in /opt/homebrew/bin/python3 /usr/local/bin/python3 /usr/bin/python3; do
  if [ -x "$sat_python" ]; then
    "$sat_python" scripts/question_bank_server.py --port 8876 --open
    sat_status=$?
    if [ "$sat_status" -ne 0 ]; then read -r -p 'Press Enter to close.'; fi
    exit "$sat_status"
  fi
done
echo 'Python 3 is required to start SAT Practice.'
read -r -p 'Press Enter to close.'
exit 1
