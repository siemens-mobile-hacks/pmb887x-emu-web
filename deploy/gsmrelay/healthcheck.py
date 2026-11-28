# Docker HEALTHCHECK: the relay answers the page's plain GET of /gsmrelay with
# {"relay": true}, which is neither logged nor counted against any limit.
import json
import sys
import urllib.request

try:
    with urllib.request.urlopen('http://127.0.0.1:4726/gsmrelay', timeout=3) as r:
        sys.exit(0 if json.load(r).get('relay') is True else 1)
except Exception:
    sys.exit(1)
