import json
cfg = json.load(open("config.json", encoding="utf-8"))
cfg["yescaptcha"]["client_key_file"] = "/opt/pixai-bridge/.keys/yescaptcha_client_key.txt"
json.dump(cfg, open("config.vps.json", "w", encoding="utf-8"), ensure_ascii=False, indent=2)
print(open("config.vps.json", encoding="utf-8").read())
