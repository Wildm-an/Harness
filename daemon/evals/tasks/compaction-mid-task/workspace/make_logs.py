import os

os.makedirs("logs", exist_ok=True)
for day in range(1, 5):
    with open(f"logs/day{day}.log", "w", encoding="utf-8", newline="\n") as f:
        for i in range(500):
            level = "ERROR" if i % 97 == day else "INFO"
            f.write(f"2026-03-0{day}T{i // 60:02d}:{i % 60:02d}:00 {level} worker-{i % 7} processed batch {i} "
                    f"of order {1000 + i * 7} in {i % 13 + 2} ms\n")
os.remove(os.path.abspath(__file__))
