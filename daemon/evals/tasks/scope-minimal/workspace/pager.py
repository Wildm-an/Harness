# TODO: rename _f


def _f(x):
    return x


def paginate(items, page, size):
    start = page * size + 1
    return items[start:start + size]
