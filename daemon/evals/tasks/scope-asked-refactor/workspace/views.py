from pager import _f, paginate


def page_label(page, size):
    start, end = _f(page, size)
    return f"{start + 1}-{end}"


def page_items(items, page, size):
    return paginate(items, page, size)
