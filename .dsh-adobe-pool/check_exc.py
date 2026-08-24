import sys
sys.path.insert(0, '/app')
from adobe_client import AdobeRequestError, UpstreamTemporaryError
e = AdobeRequestError('t', status_code=451)
print('is_temp:', isinstance(e, UpstreamTemporaryError))