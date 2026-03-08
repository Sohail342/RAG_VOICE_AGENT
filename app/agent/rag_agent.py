import json
import logging
from typing import AsyncGenerator, Optional

from app.agent.agent import VoiceAgent
from app.core.memory import memory_db
from app.core.rag import get_rag

logger = logging.getLogger(__name__)


class RAGAgent(VoiceAgent):
    """
    Extends VoiceAgent by injecting ChromaDB Context into the LLM prompt.
    """

    async def _stream_ollama(
        self, prompt: str, session_id: Optional[str] = None
    ) -> AsyncGenerator[str, None]:
        """
        Streams response from Ollama over HTTP using NDJSON, with RAG Context.
        """

        session = self._get_session()

        messages = [
            {
                "role": "system",
                "content": "You are a helpful Voice Agent, name as IndusVoiceLab built by students (Sohail, Sajjad, and Athesham) of Indus University. Keep your responses extremely concise, conversational, and natural. Do not ask multiple questions at once. You are speaking to a user who is using a voice agent. Do not mention that you are an AI or a voice agent. Just respond to the user's query.",
            }
        ]

        # Determine RAG Context
        try:
            rag = get_rag()
            context = rag.search(prompt)
            if context:
                augmented_prompt = f"{context}\nQuestion/Input: {prompt}"
                logger.info("Found relevant ChromaDB context for the prompt.")
            else:
                augmented_prompt = prompt
        except Exception as e:
            logger.error(f"RAG search error: {e}")
            augmented_prompt = prompt

        if session_id:
            # Fetch last 10 interactions context
            history = await memory_db.get_history(session_id, limit=10)
            messages.extend(history)

            # Save new ORIGINAL user query to not pollute memory with context
            await memory_db.add_message(session_id, "user", prompt)

        messages.append({"role": "user", "content": augmented_prompt})

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
