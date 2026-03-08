import logging
import uuid
from typing import Any, Dict, List

import chromadb
from chromadb import Documents, EmbeddingFunction, Embeddings
from fastembed import TextEmbedding


class CustomFastEmbedFunction(EmbeddingFunction):
    def __init__(self, model_name: str):
        self._model = TextEmbedding(model_name)

    def __call__(self, input: Documents) -> Embeddings:
        return list(self._model.embed(input))


logger = logging.getLogger(__name__)


class ChromaRAG:
    def __init__(self):
        self.collection_name = "voice_agent_docs"
        self.embedding_model = "BAAI/bge-small-en-v1.5"

        try:
            # Connect to local Chroma container
            self.client = chromadb.HttpClient(host="chroma", port=8000)
            # Use fastembed to process strings locally before sending
            self.embedding_function = CustomFastEmbedFunction(
                model_name=self.embedding_model
            )

            # Ensure collection exists
            self.collection = self.client.get_or_create_collection(
                name=self.collection_name, embedding_function=self.embedding_function
            )
            logger.info(f"Initialized ChromaDB collection: {self.collection_name}")
        except Exception as e:
            logger.error(f"Failed to initialize ChromaDB client: {e}")
            self.client = None
            self.collection = None

    def chunk_text(
        self, text: str, chunk_size: int = 1000, overlap: int = 150
    ) -> List[str]:
        """Simple recursive character text splitter equivalent to chunk text."""
        chunks = []
        start = 0
        text_length = len(text)

        while start < text_length:
            end = start + chunk_size

            # If not at the end of the text, try to find a natural break (newline or period)
            if end < text_length:
                break_chars = ["\n\n", "\n", ". "]

                for char in break_chars:
                    last_idx = text.rfind(char, start, end)
                    if last_idx != -1 and last_idx > start + (chunk_size // 2):
                        end = last_idx + len(char)
                        break

            chunks.append(text[start:end].strip())
            start = end - overlap

        return [c for c in chunks if len(c) > 50]

    async def upsert_document(self, text: str, source_metadata: Dict[str, Any]) -> int:
        """Chunks a document and upserts it into ChromaDB."""
        if not self.collection:
            logger.error("ChromaDB collection not initialized. Cannot upsert.")
            return 0

        chunks = self.chunk_text(text)
        if not chunks:
            return 0

        logger.info(
            f"Upserting {len(chunks)} chunks into ChromaDB from source '{source_metadata.get('filename', 'unknown')}'"
        )

        metadata_list = [
            {**source_metadata, "chunk_index": i} for i in range(len(chunks))
        ]

        ids = [str(uuid.uuid4()) for _ in range(len(chunks))]

        try:
            # Chroma takes care of embedding chunks via the embedding_function
            self.collection.add(documents=chunks, metadatas=metadata_list, ids=ids)
            return len(chunks)
        except Exception as e:
            logger.error(f"Failed to upsert document to ChromaDB: {e}")
            return 0

    def search(self, query: str, limit: int = 3) -> str:
        """Searches ChromaDB for context and returns formatted text to inject into prompts."""
        if not self.collection:
            return ""

        try:
            results = self.collection.query(query_texts=[query], n_results=limit)

            if not results or not results["documents"] or not results["documents"][0]:
                return ""

            relevant_chunks = []

            docs = results["documents"][0]
            metas = (
                results["metadatas"][0] if results["metadatas"] else [{}] * len(docs)
            )
            distances = (
                results["distances"][0] if results["distances"] else [0] * len(docs)
            )

            for doc, meta, distance in zip(docs, metas, distances):
                # Just include top K hits. Filtering by distance varies based on metric.
                if distance < 1.0:  # typically cosine/l2
                    filename = meta.get("filename", "unknown source")
                    relevant_chunks.append(f"Source: {filename}\nContent: {doc}")

            if relevant_chunks:
                context = "\n\n---\n\n".join(relevant_chunks)
                return f"<Information Context>\nThe following information was retrieved from the knowledge base to help answer the user:\n\n{context}\n</Information Context>\n\n"

            return ""
        except Exception as e:
            logger.error(f"ChromaDB search failed: {e}")
            return ""

    def get_uploaded_files(self) -> List[Dict[str, Any]]:
        """Returns a list of unique uploaded files from ChromaDB metadata."""
        if not self.collection:
            return []

        try:
            results = self.collection.get(include=["metadatas"])
            metadatas = results.get("metadatas", [])

            files_map = {}
            for meta in metadatas:
                if not meta:
                    continue
                filename = meta.get("filename")
                if filename:
                    if filename not in files_map:
                        files_map[filename] = {
                            "filename": filename,
                            "uploaded_by": meta.get("uploaded_by", "User"),
                            "chunks": 1,
                        }
                    else:
                        files_map[filename]["chunks"] += 1

            return list(files_map.values())
        except Exception as e:
            logger.error(f"Failed to get uploaded files: {e}")
            return []


_rag_instance = None


def get_rag() -> ChromaRAG:
    """Lazy initialization of the singleton RAG instance to prevent blocking imports."""
    global _rag_instance
    if _rag_instance is None:
        _rag_instance = ChromaRAG()
    return _rag_instance
