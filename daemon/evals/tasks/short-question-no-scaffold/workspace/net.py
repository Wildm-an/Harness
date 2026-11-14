import time


def retry(fn, attempts=3, delay=0.5):
    for i in range(attempts):
        try:
            return fn()
        except OSError:
            if i == attempts - 1:
                raise
            time.sleep(delay * 2 ** i)


def fetch(url):
    raise OSError(f"no network for {url}")
