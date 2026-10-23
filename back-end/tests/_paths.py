"""Resolve the four-directory checkout for standard-library test discovery."""
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
BACK_END = ROOT / 'back-end'
sys.path.insert(0, str(BACK_END))
