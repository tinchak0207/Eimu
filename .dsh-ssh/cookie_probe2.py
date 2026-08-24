import sys, json
sys.path.insert(0, "/app")
from camou_launch import launch_options, safe_launch

profile_dir = "/app/profiles/AntoinetteVogele45954008@hotmail.com"
opts = launch_options(profile_dir=profile_dir)
with safe_launch(opts) as browser:
    page = browser.new_page()
    page.goto("https://dreamina.capcut.com/ai-tool/home", wait_until="domcontentloaded", timeout=45000)
    page.wait_for_timeout(10000)
    print("URL:", page.url, flush=True)
    body = page.inner_text("body").lower()
    print("FREE_CREDITS:", "free credits" in body, flush=True)
    print("IMAGE_5_LITE:", "image 5.0 lite" in body, flush=True)
    print("IMAGE_5_PRO:", "image 5.0 pro" in body, flush=True)
    print("CONTINUE_EMAIL:", "continue with email" in body, flush=True)
    print("BODY[:200]:", body[:200].replace(chr(10), " | "), flush=True)
