import asyncio
import io
import logging

from faster_whisper import WhisperModel

logger = logging.getLogger(__name__)


class SpeechToText:
    """
    Wrapper for faster-whisper transcription.
    Converts audio bytes to text asynchronously using a thread pool.
    """

    def __init__(
        self, model_size: str = "base", device: str = "cpu", compute_type: str = "int8"
    ):
        logger.info(f"Loading faster-whisper model '{model_size}' on '{device}'...")
        self.model = WhisperModel(model_size, device=device, compute_type=compute_type)

    async def transcribe(self, audio_bytes: bytes) -> str:
        """
        Transcribes the given audio bytes.
        Expects a format supported by FFmpeg/faster-whisper (like WAV, WebM).
        """
        if not audio_bytes:
            return ""

        def _transcribe():
            audio_io = io.BytesIO(audio_bytes)
            # Transcribe from file-like object
            try:
                segments, _ = self.model.transcribe(
                    audio_io,
                    beam_size=5,
                    language="en",
                    vad_filter=True,
                    vad_parameters=dict(min_silence_duration_ms=500),
                    initial_prompt="A clear, conversational interaction with a helpful AI voice assistant.",
                    condition_on_previous_text=False,
                )
                # Combine all segments
                return " ".join(segment.text for segment in segments).strip()
            except Exception as ffmpeg_err:
                logger.warning(
                    f"Audio transcription warning (often due to missing webm headers in chunked streams): {ffmpeg_err}"
                )
                return ""

        try:
            return await asyncio.to_thread(_transcribe)
        except Exception as e:
            logger.error(f"Error executing STT thread: {e}")
            return ""
