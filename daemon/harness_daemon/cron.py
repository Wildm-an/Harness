"""Cron expressions for the recurring tasks of the agent (cron_create in tools/tasks.py).

Five fields in the local time of the computer: minute (0-59), hour (0-23), day of the month (1-31),
month (1-12), and day of the week (0-6, 0 and 7 are Sunday). A field is ``*``, a number, a range
``a-b``, a step ``*/n`` or ``a-b/n``, or a list of these with commas. When both day fields are not
``*``, a day that matches one of them matches (as in standard cron).
"""

from __future__ import annotations

import datetime as dt
from dataclasses import dataclass

LIMITS = ((0, 59), (0, 23), (1, 31), (1, 12), (0, 7))
NAMES = ("minute", "hour", "day of the month", "month", "day of the week")
SEARCH_DAYS = 366 * 4  # A date such as February 29 can be 4 years away.


class CronError(ValueError):
    pass


def _field(text: str, index: int) -> frozenset[int]:
    low, high = LIMITS[index]
    values: set[int] = set()
    for part in text.split(","):
        part = part.strip()
        if not part:
            raise CronError(f"The {NAMES[index]} field has an empty part.")
        base, _, step_text = part.partition("/")
        step = 1
        if step_text:
            if not step_text.isdigit() or int(step_text) < 1:
                raise CronError(f"The step in the {NAMES[index]} field must be a number of 1 or more.")
            step = int(step_text)
        if base == "*":
            start, end = low, high
        elif "-" in base:
            a, _, b = base.partition("-")
            if not (a.isdigit() and b.isdigit()):
                raise CronError(f"'{part}' is not a valid range in the {NAMES[index]} field.")
            start, end = int(a), int(b)
        elif base.isdigit():
            start = int(base)
            end = high if step_text else start
        else:
            raise CronError(f"'{part}' is not valid in the {NAMES[index]} field. Use numbers, *, -, /, and commas.")
        if not (low <= start <= high and low <= end <= high) or start > end:
            raise CronError(f"The {NAMES[index]} field must be from {low} to {high}.")
        values.update(range(start, end + 1, step))
    if index == 4 and 7 in values:  # 7 is Sunday too.
        values.discard(7)
        values.add(0)
    return frozenset(values)


@dataclass(frozen=True)
class Cron:
    text: str
    minutes: frozenset[int]
    hours: frozenset[int]
    days: frozenset[int]
    months: frozenset[int]
    weekdays: frozenset[int]  # 0 is Sunday.
    any_day: bool
    any_weekday: bool

    def _day_ok(self, day: dt.date) -> bool:
        weekday = (day.weekday() + 1) % 7  # Python: Monday is 0. Cron: Sunday is 0.
        if day.month not in self.months:
            return False
        if self.any_day and self.any_weekday:
            return True
        if self.any_day:
            return weekday in self.weekdays
        if self.any_weekday:
            return day.day in self.days
        return day.day in self.days or weekday in self.weekdays

    def next_after(self, after: dt.datetime) -> dt.datetime | None:
        """The first time that matches, after ``after`` (to the minute). None if no time matches."""
        start = after.replace(second=0, microsecond=0) + dt.timedelta(minutes=1)
        hours, minutes = sorted(self.hours), sorted(self.minutes)
        for offset in range(SEARCH_DAYS):
            day = start.date() + dt.timedelta(days=offset)
            if not self._day_ok(day):
                continue
            for hour in hours:
                for minute in minutes:
                    candidate = dt.datetime.combine(day, dt.time(hour, minute))
                    if candidate >= start:
                        return candidate
        return None


def parse_cron(text: str) -> Cron:
    fields = (text or "").split()
    if len(fields) != 5:
        raise CronError("A cron expression has 5 fields: minute hour day-of-month month day-of-week, "
                        "for example '*/5 * * * *' or '0 9 * * 1-5'.")
    parsed = [_field(f, i) for i, f in enumerate(fields)]
    cron = Cron(" ".join(fields), *parsed, any_day=fields[2] == "*", any_weekday=fields[4] == "*")
    if cron.next_after(dt.datetime.now()) is None:
        raise CronError(f"No date matches '{cron.text}'.")
    return cron
