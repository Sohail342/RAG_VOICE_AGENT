import json
import logging
from typing import AsyncGenerator, Optional

import aiohttp

from app.core.config import settings

logger = logging.getLogger(__name__)


class VoiceAgent:
    """
    Orchestrates the STT -> LLM -> TTS pipeline asynchronously.
    """

    def __init__(
        self,
        stt_service,
        tts_service,
        sentence_buffer,
        ollama_url: str = f"{settings.OLLAMA_API_BASE_URL}/api/chat",
        ollama_model: str = settings.OLLAMA_MODEL,
    ):
        self.stt = stt_service
        self.tts = tts_service
        self.sentence_buffer = sentence_buffer
        self.ollama_url = ollama_url
        self.ollama_model = ollama_model

        # Reuse aiohttp ClientSession for performance
        self.client_session: Optional[aiohttp.ClientSession] = None

    def _get_session(self) -> aiohttp.ClientSession:
        """Lazily initialize the aiohttp session."""
        if self.client_session is None or self.client_session.closed:
            self.client_session = aiohttp.ClientSession()
        return self.client_session

    async def close(self):
        """Close the aiohttp session."""
        if self.client_session and not self.client_session.closed:
            await self.client_session.close()

    async def _stream_ollama(
        self, prompt: str, session_id: Optional[str] = None
    ) -> AsyncGenerator[str, None]:
        """
        Streams response from Ollama over HTTP using NDJSON.
        """
        from app.core.memory import memory_db

        session = self._get_session()

        messages = [
            {
                "role": "system",
                "content": "You are a helpful Voice Agent, name as IndusVoiceLab built by students (Sohail, Sajjad, and Athesham) of Indus University. Keep your responses extremely concise, conversational, and natural. Do not ask multiple questions at once. You are speaking to a user who is using a voice agent. Do not mention that you are an AI or a voice agent. Just respond to the user's query.",
            }
        ]

        if session_id:
            # Fetch last 10 interactions context
            history = await memory_db.get_history(session_id, limit=10)
            messages.extend(history)

            # Save new ORIGINAL user query just in case
            await memory_db.add_message(session_id, "user", prompt)

        messages.append({"role": "user", "content": prompt})

        payload = {
            "model": self.ollama_model,
            "messages": messages,
            "stream": True,
            "keep_alive": -1,  # Keep model loaded indefinitely
        }

        full_response = []

        try:
            async with session.post(self.ollama_url, json=payload) as response:
                response.raise_for_status()

                # Iterate over the NDJSON lines asynchronously
                async for line in response.content:
                    line = line.strip()
                    if not line:
                        continue

                    data = json.loads(line.decode("utf-8"))

                    if "message" in data and "content" in data["message"]:
                        chunk = data["message"]["content"]
                        full_response.append(chunk)
                        yield chunk

                    if data.get("done"):
                        break

            # Save the final text back to memory
            if full_response:
                assistant_text = "".join(full_response).strip()
                if assistant_text:
                    if session_id:
                        await memory_db.add_message(
                            session_id, "assistant", assistant_text
                        )

        except Exception as e:
            logger.error(f"Error communicating with Ollama: {e}")
            yield "Sorry, I had trouble thinking of a response."

    async def process_audio_stream(
        self, audio_bytes: bytes, session_id: Optional[str] = None, tts_service=None
    ) -> AsyncGenerator[bytes, None]:
        """
        Main pipeline: Audio -> STT -> LLM Stream -> Sentence Buffer -> TTS -> Audio chunks
        """
        # Transcribe audio
        try:
            text = await self.stt.transcribe(audio_bytes)
            logger.info(f"User Transcribed: '{text}'")
        except Exception as e:
            logger.error(f"STT Pipeline error: {e}")
            yield b""
            return

        if not text or not text.strip():
            # False alarm (e.g. ambient noise or throat clear)
            logger.info(
                "Empty transcription. Ignoring (no message, don't send to LLM)."
            )
            yield b""
            return

        llm_stream = self._stream_ollama(text, session_id=session_id)

        # Buffer into sentences before TTS to avoid weird intonation
        sentence_stream = self.sentence_buffer.process_stream(llm_stream)

        # Generate audio sequentially per sentence and stream back to client
        target_tts = tts_service or self.tts
        async for sentence in sentence_stream:
            if not sentence.strip():
                continue

            logger.info(f"Agent generating TTS for: {sentence}")
            try:
                # Get wav audio
                audio_chunk = await target_tts.generate_audio(sentence)
                yield audio_chunk
            except Exception as e:
                logger.error(
                    f"Error generating audio for sentence '{sentence}': {e}", flush=True
                )

    async def process_text_prompt(
        self, prompt: str, session_id: Optional[str] = None, tts_service=None
    ) -> AsyncGenerator[bytes, None]:
        """
        Processes a raw text prompt through the LLM -> TTS pipeline.
        Useful for triggering initial greetings without audio input.
        """
        logger.info(f"Agent processing text prompt: '{prompt}'")

        llm_stream = self._stream_ollama(prompt, session_id=session_id)

        # Buffer into sentences before TTS to avoid weird intonation
        sentence_stream = self.sentence_buffer.process_stream(llm_stream)

        # Generate audio sequentially per sentence and stream back to client
        target_tts = tts_service or self.tts
        async for sentence in sentence_stream:
            if not sentence.strip():
                continue

            logger.info(f"Agent generating TTS for: {sentence}")
            try:
                # Get wav audio
                audio_chunk = await target_tts.generate_audio(sentence)
                yield audio_chunk
            except Exception as e:
                logger.error(
                    f"Error generating audio for sentence '{sentence}': {e}", flush=True
                )

    async def generate_greeting(self, text: str, tts_service=None) -> bytes:
        """
        Directly generates TTS for a specific string (used for initial connection greeting).
        """
        logger.info(f"Agent generating Greeting TTS: {text}")
        target_tts = tts_service or self.tts
        try:
            audio_chunk = await target_tts.generate_audio(text)
            return audio_chunk
        except Exception as e:
            logger.error(f"Error generating greeting audio: {e}")
            return b""

    async def process_text_chat(
        self, prompt: str, session_id: Optional[str] = None
    ) -> AsyncGenerator[str, None]:
        """
        Processes a raw text prompt and yields text responses directly (no TTS/STT).
        """
        logger.info(f"Agent processing text chat: '{prompt}'")
        async for chunk in self._stream_ollama(prompt, session_id=session_id):
            yield chunk
