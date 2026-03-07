"""User model for Beanie modular projects."""

from beanie import Document
from fastapi_users.db import BeanieBaseUser


class User(BeanieBaseUser, Document):
    first_name: str | None = None
    last_name: str | None = None
