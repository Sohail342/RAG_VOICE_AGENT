"""MongoDB configuration for Beanie modular projects."""

from typing import AsyncGenerator

from motor.motor_asyncio import AsyncIOMotorClient

from app.core.config import settings
from app.database.base import document_models

client: AsyncIOMotorClient | None = None


async def init_db() -> None:
    """Initialize database connection and Beanie."""
    global client
    client = AsyncIOMotorClient(settings.MONGODB_URL)
    database = client[settings.MONGO_DB]

    # Initialize Beanie with the User document class
    from beanie import init_beanie

    await init_beanie(database, document_models=document_models)


async def close_db() -> None:
    """Close database connection."""
    global client
    if client:
        client.close()


async def get_db() -> AsyncGenerator[None, None]:
    """Database dependency for FastAPI."""
    # Ensure database is initialized
    if not client:
        await init_db()
    yield


# For Celery tasks
async def get_db_for_celery() -> None:
    """Database initialization for Celery tasks."""
    await init_db()
