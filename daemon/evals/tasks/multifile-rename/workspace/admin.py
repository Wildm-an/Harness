from repo import UserRepo


def reset(repo: UserRepo) -> UserRepo:
    """Give a new, empty UserRepo."""
    return UserRepo()
