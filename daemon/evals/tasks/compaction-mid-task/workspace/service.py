from repo import UserRepo


class UserService:
    def __init__(self, repo=None):
        self.repo = repo or UserRepo()

    def register(self, user_id, name):
        self.repo.add(user_id, name.strip())
        return self.repo.get(user_id)
