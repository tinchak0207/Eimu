import re
s = open("/home/lenovo/.nvm/versions/node/v24.19.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-slots/lib/index.d.ts").read()
names = sorted(set(re.findall(r"['"]([a-z][a-z0-9.]+)['"]", s)))
open("/home/lenovo/Desktop/image-app/.tmp-sx.txt", "w").write("
".join(names))
