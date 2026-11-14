import sys

from inventory import total_items

CHECKS = {
    "check_names": lambda: True,
    "check_total": lambda: total_items() == 12,
    "check_empty": lambda: True,
}

failed = [name for name, check in CHECKS.items() if not check()]
for name in CHECKS:
    print(f"{name}: {'FAIL' if name in failed else 'ok'}")
sys.exit(1 if failed else 0)
