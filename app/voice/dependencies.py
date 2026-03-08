import logging

from app.agent.agent import VoiceAgent
from app.core.config import settings

from .sentence_buffer import SentenceBuffer
from .stt import SpeechToText
from .tts import TextToSpeech

logger = logging.getLogger(__name__)

# Global dependencies
_stt_service = None
_tts_service = None
_voice_agent = None


def get_voice_agent() -> VoiceAgent:
    """Dependency to retrieve the initialized voice agent."""
    global _voice_agent
    if _voice_agent is None:
        raise RuntimeError(
            "VoiceAgent is not initialized. Ensure init_voice_services was called during startup."
        )
    return _voice_agent


def init_voice_services():
    """
    Initialize heavy models on startup.
    Ensure that model paths and binaries exist as needed.
    """
    global _stt_service, _tts_service, _voice_agent

    logger.info("Initializing Voice Agent services...")
    # base.en is much faster and more accurate than tiny for English exclusively.
    _stt_service = SpeechToText(model_size="base.en", device="cpu", compute_type="int8")

    try:
        _tts_service = TextToSpeech(
            model_path="app/llm/model/en_US-hfc_female-medium.onnx",
            config_path="app/llm/model/en_US-hfc_female-medium.onnx.json",
        )
    except Exception as e:
        logger.warning(
            f"Failed to initialize TTS. (Did you download a Piper model to 'models/'?): {e}"
        )

    _voice_agent = VoiceAgent(
        stt_service=_stt_service,
        tts_service=_tts_service,
        sentence_buffer=SentenceBuffer(),
        ollama_url=f"{settings.OLLAMA_API_BASE_URL}/api/chat",
        ollama_model=settings.OLLAMA_MODEL,
    )


async def close_voice_services():
    """Cleanup resources on application shutdown."""
    global _voice_agent
    if _voice_agent:
        logger.info("Closing Voice Agent connections...")
        await _voice_agent.close()
