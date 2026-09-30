"""Make bridge tests runnable from the repository root without global PYTHONPATH."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
