def _f(page, size):
    start = page * size + 1
    return start, start + size


def paginate(items, page, size):
    start, end = _f(page, size)
    return items[start:end]
