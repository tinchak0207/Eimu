import subprocess, sys
key = open(r"C:\Users\lenovo\Documents\trae_projects\AICoach\.codex-tmp\turb-gpt-free-register-review\.data\yescaptcha_client_key.txt", encoding="utf-8").read().strip()
remote = "/opt/pixai-bridge/.keys/yescaptcha_client_key.txt"
r = subprocess.run(['ssh', '-i', 'C:/Users/lenovo/Downloads/new.pem', 'ubuntu@43.172.85.76',
                    f'mkdir -p /opt/pixai-bridge/.keys && echo -n "{key}" | sudo tee {remote} >/dev/null && wc -c {remote}'],
                   capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=60)
sys.stdout.buffer.write(r.stdout.encode('utf-8', 'replace')[:500])
