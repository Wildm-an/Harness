import json

import requests as rq


def push(url, data):
    return rq.post(url, data=json.dumps(data), timeout=10)
