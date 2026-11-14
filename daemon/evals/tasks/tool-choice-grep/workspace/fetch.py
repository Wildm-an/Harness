import requests


def get_json(url):
    return requests.get(url, timeout=10).json()
