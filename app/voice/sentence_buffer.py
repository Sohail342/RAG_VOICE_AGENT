import re
from typing import AsyncGenerator, AsyncIterator


class SentenceBuffer:
    """
    Accumulates tokens from an LLM and yields complete sentences.
    This ensures that the TTS engine receives logical chunks of text
    with proper punctuation rather than individual tokens.
    """

    def __init__(self):
        # Regex to split on spaces following sentence-ending punctuation.
        self.sentence_boundary = re.compile(
            r"(?<=(?<!Dr)(?<!Mr)(?<!Ms)(?<!Mrs)(?<!St)[.!?])\s+(?=[A-Z])"
        )

    async def process_stream(
        self, token_stream: AsyncIterator[str]
    ) -> AsyncGenerator[str, None]:
        buffer = ""

        async for token in token_stream:
            buffer += token

            # Split buffer by sentence boundaries
            parts = self.sentence_boundary.split(buffer)

            # If we have more than 1 part, it means we've found at least one boundary
            if len(parts) > 1:
                # Yield all complete sentences (everything except the last part)
                for sentence in parts[:-1]:
                    clean_sentence = sentence.strip()
                    if clean_sentence:
                        yield clean_sentence

                buffer = parts[-1]

        buffer = buffer.strip()
        if buffer:
            yield buffer
