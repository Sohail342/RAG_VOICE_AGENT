import logging
from typing import Dict, Optional

from app.agent.agent import VoiceAgent
from app.agent.rag_agent import RAGAgent
from app.core.config import settings

from .sentence_buffer import SentenceBuffer
from .stt import SpeechToText
from .tts import TextToSpeech

logger = logging.getLogger(__name__)

# Global dependencies
_stt_service = None
_tts_services: Dict[str, TextToSpeech] = {}
_voice_agent = None
_rag_agent = None


def get_voice_agent() -> VoiceAgent:
    """Dependency to retrieve the initialized voice agent."""
    global _voice_agent
    if _voice_agent is None:
        raise RuntimeError(
            "VoiceAgent is not initialized. Ensure init_voice_services was called during startup."
        )
    return _voice_agent


def get_rag_agent() -> RAGAgent:
    """Dependency to retrieve the initialized RAG agent."""
    global _rag_agent
    if _rag_agent is None:
        raise RuntimeError(
            "RAGAgent is not initialized. Ensure init_voice_services was called during startup."
        )
    return _rag_agent


def get_tts_service(voice_id: str = "hfc") -> TextToSpeech:
    """Dependency to retrieve a specific TTS service by voice_id."""
    global _tts_services
    service = _tts_services.get(voice_id)
    if service is None:
        # Fallback to hfc if requested id not found
        service = _tts_services.get("hfc")
    
    if service is None:
         raise RuntimeError(
            f"TTS service '{voice_id}' is not initialized. Ensure init_voice_services was called."
        )
    return service


def init_voice_services():
    """
    Initialize heavy models on startup.
    Ensure that model paths and binaries exist as needed.
    """
    global _stt_service, _tts_services, _voice_agent, _rag_agent

    logger.info("Initializing Voice Agent services...")
    # base.en is much faster and more accurate than tiny for English exclusively.
    _stt_service = SpeechToText(model_size="base.en", device="cpu", compute_type="int8")

    models_to_load = {
        "amy": "app/llm/model/en_US-amy-medium.onnx",
        "hfc": "app/llm/model/en_US-hfc_female-medium.onnx",
        "kristin": "app/llm/model/en_US-kristin-medium.onnx",
        "ljspeech": "app/llm/model/en_US-ljspeech-high.onnx",
    }

    for vid, mpath in models_to_load.items():
        try:
            _tts_services[vid] = TextToSpeech(
                model_path=mpath,
                config_path=f"{mpath}.json",
            )
        except Exception as e:
            logger.warning(
                f"Failed to initialize TTS model '{vid}' at {mpath}: {e}"
            )

    # Initialize VoiceAgent with default 'hfc' voice for legacy/internal calls
    default_tts = _tts_services.get("hfc")

    _voice_agent = VoiceAgent(
        stt_service=_stt_service,
        tts_service=default_tts,
        sentence_buffer=SentenceBuffer(),
        ollama_url=f"{settings.OLLAMA_API_BASE_URL}/api/chat",
        ollama_model=settings.OLLAMA_MODEL,
    )

    _rag_agent = RAGAgent(
        stt_service=_stt_service,
        tts_service=default_tts,
        sentence_buffer=SentenceBuffer(),
        ollama_url=f"{settings.OLLAMA_API_BASE_URL}/api/chat",
        ollama_model=settings.OLLAMA_MODEL,
    )


async def close_voice_services():
    """Cleanup resources on application shutdown."""
    global _voice_agent, _rag_agent
    if _voice_agent:
        logger.info("Closing Voice Agent connections...")
        await _voice_agent.close()
    if _rag_agent:
        logger.info("Closing RAG Agent connections...")
        await _rag_agent.close()
