import json
import logging
from typing import List

from redis.asyncio import Redis

from app.core.config import settings

logger = logging.getLogger(__name__)


class RedisMemory:
    """
    Manages conversational memory using Redis.
    Stores and retrieves message history for a given session ID.
    """

    def __init__(self, redis_url: str = settings.REDIS_URL, ttl: int = 86400):
        self.redis = Redis.from_url(redis_url, decode_responses=True)
        self.ttl = ttl  # 24 hours (86400 seconds)

    async def get_history(self, session_id: str, limit: int = 10) -> List[dict]:
        """
        Retrieves the last `limit` messages for the given session_id.
        """
        key = f"chat_history:{session_id}"
        try:
            # lrange returns elements from start to stop.
            raw_messages = await self.redis.lrange(key, -limit, -1)
            history = []
            for msg in raw_messages:
                try:
                    history.append(json.loads(msg))
                except json.JSONDecodeError:
                    continue
            return history
        except Exception as e:
            logger.error(f"Error fetching memory for {session_id}: {e}")
            return []

    async def add_message(self, session_id: str, role: str, content: str):
        """
        Appends a new message to the history and resets the TTL.
        """
        key = f"chat_history:{session_id}"
        message = json.dumps({"role": role, "content": content})
        try:
            await self.redis.rpush(key, message)
            await self.redis.expire(key, self.ttl)
        except Exception as e:
            logger.error(f"Error saving memory for {session_id}: {e}")

    async def clear_history(self, session_id: str):
        """Clears the chat history for a given session."""
        key = f"chat_history:{session_id}"
        try:
            await self.redis.delete(key)
        except Exception as e:
            logger.error(f"Error clearing memory for {session_id}: {e}")

    async def close(self):
        """Closes the Redis connection."""
        await self.redis.aclose()


# Singleton instance
memory_db = RedisMemory()
