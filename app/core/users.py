"""FastAPIUsers object to generate the actual API routes"""

import uuid

from fastapi_users import FastAPIUsers

from app.core.security import auth_backend
from app.models.users import User
from app.users.manager import get_user_manager

fastapi_users = FastAPIUsers[User, uuid.UUID](
    get_user_manager,
    [auth_backend],
)

current_user = fastapi_users.current_user()
current_active_user = fastapi_users.current_user(active=True)
current_active_verified_user = fastapi_users.current_user(active=True, verified=True)
current_superuser = fastapi_users.current_user(active=True, superuser=True)
