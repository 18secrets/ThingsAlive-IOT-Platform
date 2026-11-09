# Entry point for Railway (Railpack runs main.py). The receiver itself is unchanged; it
# sits two folders deep because it derives PROJECT_ROOT as Path(__file__).parents[2].
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "receiver" / "motor"))

from motor_logger_http_server import main  # noqa: E402

main()
