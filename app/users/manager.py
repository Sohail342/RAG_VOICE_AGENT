from fastapi import Depends
from fastapi_users import BaseUserManager, UUIDIDMixin

from app.core.config import settings
from app.models.users import User
from app.users.dependencies import get_user_db

SECRET = settings.SECRET_KEY


class UserManager(UUIDIDMixin, BaseUserManager[User, str]):
    reset_password_token_secret = SECRET
    verification_token_secret = SECRET


async def get_user_manager(user_db=Depends(get_user_db)):
    yield UserManager(user_db)
