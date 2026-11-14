import argparse
import sys


def counts(text):
    return {"words": len(text.split()), "lines": len(text.splitlines())}


def main(argv=None):
    parser = argparse.ArgumentParser(description="Count the words and the lines of a file.")
    parser.add_argument("path")
    args = parser.parse_args(argv)
    with open(args.path, encoding="utf-8") as f:
        result = counts(f.read())
    print(f"words: {result['words']}")
    print(f"lines: {result['lines']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
