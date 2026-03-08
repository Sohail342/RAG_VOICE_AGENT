import logging

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.voice.dependencies import get_voice_agent

logger = logging.getLogger(__name__)
router = APIRouter()


class ChatRequest(BaseModel):
    message: str


@router.post("")
async def chat_endpoint(request: ChatRequest):
    """
    Endpoint for text-based chat.
    Bypasses STT/TTS and streams text directly from the LLM.
    Requires authentication.
    """
    try:
        agent = get_voice_agent()

        async def generate():
            async for chunk in agent.process_text_chat(request.message):
                yield chunk

        return StreamingResponse(generate(), media_type="text/plain")

    except Exception as e:
        logger.error(f"Error in chat endpoint: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")
