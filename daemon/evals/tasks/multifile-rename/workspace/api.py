from service import UserService

SERVICE = UserService()


def handle_register(payload):
    return {"name": SERVICE.register(payload["id"], payload["name"])}
