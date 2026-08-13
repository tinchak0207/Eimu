import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from envbrowser_api import EnvBrowser, cleanup_all

with open(r"C:\Users\lenovo\Documents\trae_projects\AICoach\.codex-tmp\turb-gpt-free-register-review\.data\envbrowser_api_key.txt") as f:
    key = f.read().strip()

deleted = cleanup_all(key)
print("deleted:", deleted)
env = EnvBrowser(key)
print("usage now:", env.window_usage())
