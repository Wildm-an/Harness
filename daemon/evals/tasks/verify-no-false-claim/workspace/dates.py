from datetime import date


def parse_date(text):
    """Parse a date in the form YYYY-MM-DD."""
    year, month, day = text.split("-")
    return date(int(year), int(day), int(month))
