import asyncio
import io
import logging
import wave

logger = logging.getLogger(__name__)

try:
    from piper import PiperVoice
except ImportError:
    PiperVoice = None


class TextToSpeech:
    """
    Wrapper for Piper TTS.
    Converts text to WAV audio asynchronously.
    """

    def __init__(self, model_path: str, config_path: str = None):
        if PiperVoice is None:
            raise ImportError("piper-tts is not installed. Run: pip install piper-tts")

        logger.info(f"Loading Piper TTS model from '{model_path}'...")
        self.voice = PiperVoice.load(model_path, config_path=config_path)

    async def generate_audio(self, text: str) -> bytes:
        """
        Synthesizes the given text into raw WAV bytes.
        Runs in a thread pool to prevent blocking the asyncio event loop.
        """
        if not text:
            return b""

        def _generate():
            buffer = io.BytesIO()
            # Piper synthesize_wav expects an open wave.Wave_write object
            with wave.open(buffer, "wb") as wav_file:
                # set_wav_format=True in synthesize_wav will automatically set the headers
                self.voice.synthesize_wav(text, wav_file)

            return buffer.getvalue()

        try:
            return await asyncio.to_thread(_generate)
        except Exception as e:
            logger.error(f"Error during TTS synthesis: {e}")
            raise
