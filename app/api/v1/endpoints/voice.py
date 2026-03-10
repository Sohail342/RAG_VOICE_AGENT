import logging
from typing import Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from starlette.websockets import WebSocketState

from app.voice.dependencies import get_voice_agent, get_tts_service

logger = logging.getLogger(__name__)
router = APIRouter()


@router.websocket("")
async def voice_websocket_endpoint(
    websocket: WebSocket,
    session_id: Optional[str] = None,
    voice_id: str = "hfc",
):
    """
    WebSocket endpoint for real-time voice communication.
    Requires a valid JWT token in the 'token' query parameter.
    """
    await websocket.accept()

    try:
        agent = get_voice_agent()
        tts_service = get_tts_service(voice_id)

        # Send initial greeting immediately via LLM
        greeting_prompt = "Introduce yourself as a Voice Agent built by Indus university Students. Ask the user how you can help them today. Keep it brief."
        async for greeting_audio in agent.process_text_prompt(
            greeting_prompt, session_id=session_id, tts_service=tts_service
        ):
            if websocket.client_state == WebSocketState.CONNECTED:
                await websocket.send_bytes(greeting_audio)
        # Signal end of turn after greeting
        await websocket.send_json({"type": "end_of_turn"})
    except RuntimeError as e:
        logger.error(str(e))
        await websocket.close(code=1011, reason="Voice Agent service unavailable")
        return

    try:
        while True:
            try:
                # Expecting raw audio bytes or a "TIMEOUT" text flag
                message = await websocket.receive()
            except RuntimeError:
                logger.debug("WebSocket client disconnected during receive.")
                break

            if "bytes" in message:
                audio_data = message["bytes"]
                logger.info(f"Received audio packet: {len(audio_data)} bytes")

                # The agent generator streams synthesized sentences one by one
                async for response_audio in agent.process_audio_stream(
                    audio_data, session_id=session_id, tts_service=tts_service
                ):
                    if websocket.client_state == WebSocketState.CONNECTED:
                        # Send TTS audio back over websocket
                        await websocket.send_bytes(response_audio)
                        logger.info(
                            f"Sent TTS audio packet: {len(response_audio)} bytes"
                        )
                # Signal end of turn after processing audio stream
                await websocket.send_json({"type": "end_of_turn"})
            elif "text" in message:
                text_data = message["text"]
                if text_data == "TIMEOUT":
                    logger.info(
                        "Received TIMEOUT flag from client. Prompting LLM proactively."
                    )
                    prompt = "(The user has remained silent. Ask a very brief, friendly question to encourage them to speak or ask if they are still there.)"
                    async for response_audio in agent.process_text_prompt(
                        prompt, session_id=session_id, tts_service=tts_service
                    ):
                        if websocket.client_state == WebSocketState.CONNECTED:
                            await websocket.send_bytes(response_audio)
                    # Signal end of turn after timeout prompt
                    await websocket.send_json({"type": "end_of_turn"})

    except WebSocketDisconnect:
        logger.info("Voice WebSocket disconnected gracefully by the client.")
    except Exception as e:
        logger.error(f"Voice WebSocket error occurred: {e}")
