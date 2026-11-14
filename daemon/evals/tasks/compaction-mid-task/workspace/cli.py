import sys

from repo import UserRepo


def main(argv):
    repo = UserRepo()
    for i, name in enumerate(argv):
        repo.add(i, name)
    print(f"{len(argv)} users in the UserRepo")


if __name__ == "__main__":
    main(sys.argv[1:])
