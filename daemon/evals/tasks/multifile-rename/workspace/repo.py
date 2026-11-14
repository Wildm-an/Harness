class UserRepo:
    """Keeps the users in memory."""

    def __init__(self):
        self._users = {}

    def add(self, user_id, name):
        self._users[user_id] = name

    def get(self, user_id):
        return self._users.get(user_id)
