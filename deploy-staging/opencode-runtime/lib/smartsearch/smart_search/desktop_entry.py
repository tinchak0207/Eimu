"""Frozen executable and development module entry point."""
import sys


def main():
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        if stream is not None and hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    if sys.argv[1:2] == ["--desktop-backend"]:
        from smart_search.desktop_backend import main as run
    elif sys.argv[1:2] == ["--desktop-worker"]:
        from smart_search.desktop_worker import main as run
    else:
        from smart_search.cli import main as run
    return run()


if __name__ == "__main__":
    raise SystemExit(main())
