"""API v1 router configuration."""

from fastapi import APIRouter

from app.api.v1.endpoints import voice, chat
from app.core.security import auth_backend
from app.core.users import fastapi_users
from app.schemas.user import UserCreate, UserRead, UserUpdate

api_v1_router = APIRouter(prefix="/api/v1")

# FastAPI-Users routers
api_v1_router.include_router(
    fastapi_users.get_auth_router(auth_backend),
    prefix="/auth",
    tags=["auth"],
)
api_v1_router.include_router(
    fastapi_users.get_register_router(UserRead, UserCreate),
    prefix="/auth",
    tags=["auth"],
)
api_v1_router.include_router(
    fastapi_users.get_verify_router(UserRead),
    prefix="/auth",
    tags=["auth"],
)
api_v1_router.include_router(
    fastapi_users.get_users_router(UserRead, UserUpdate),
    prefix="/users",
    tags=["users"],
)
api_v1_router.include_router(
    voice.router,
    prefix="/voice",
    tags=["voice"],
)
api_v1_router.include_router(
    chat.router,
    prefix="/chat",
    tags=["chat"],
)
