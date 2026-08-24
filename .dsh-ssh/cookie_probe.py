import sys, json
sys.path.insert(0, "/app")
from camou_launch import launch_options, safe_launch

profile_dir = "/app/profiles/AntoinetteVogele45954008@hotmail.com"
opts = launch_options(profile_dir=profile_dir)
with safe_launch(opts) as browser:
    try:
        cookies = browser.cookies()
        capcut = [c for c in cookies if "capcut" in c.get("domain", "")]
        print("CONTEXT_COOKIES total:", len(cookies), "capcut:", len(capcut), flush=True)
        for c in capcut[:10]:
            print("  ", c.get("domain"), c.get("name"), "expires:", c.get("expires"), flush=True)
    except Exception as e:
        print("COOKIE_READ_ERR", repr(e), flush=True)
