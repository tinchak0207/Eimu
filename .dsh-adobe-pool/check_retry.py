import sys
sys.path.insert(0, '/app')
import adobe_client as ac
cls = None
for name in dir(ac):
    obj = getattr(ac, name)
    if isinstance(obj, type) and hasattr(obj, 'retry_max_attempts'):
        cls = obj; break
print('class:', cls.__name__)
# find live instance: check app module
import importlib
app_mod = None
try:
    app_mod = importlib.import_module('api.routes.generation')
except Exception as e:
    print('import gen route failed:', e); sys.exit(0)