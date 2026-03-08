# 🎙️ RAG Voice Agent

![RAG Voice Agent Logo](/logo.png)

> **Intelligence Redefined.** A high-performance, private-by-design Voice Agent powered by Retrieval-Augmented Generation.

---

## 🌟 Overview

The **RAG Voice Agent** is a cutting-edge multimodal assistant that combines the power of Local LLMs with real-time speech processing and historical knowledge retrieval. Built with a focus on privacy and low-latency, it allows users to interact with their data through both voice and text, ensuring that proprietary information never leaves their infrastructure.

### 🚀 Key Features

*   **🧠 Knowledge-Driven Chat (RAG)**: Leverages Retrieval-Augmented Generation to provide context-aware responses based on your local knowledge base.
*   **🗣️ Low-Latency Neural Voice**: A high-performance pipeline using **Faster-Whisper** for STT and **Piper** for TTS, delivering near-instant human-like conversations.
*   **🔒 Private by Design**: Completely local-first processing. No external APIs, no data leaks. Your intelligence remains yours.
*   **💬 Multimodal Interaction**: Seamlessly switch between real-time voice calls and a modern text-based chat interface.
*   **🛡️ Secure & Persistent**: Full JWT-based authentication with session persistence and secure WebSocket communication.

---

## 🏗️ Neural Architecture

The agent orchestrates a sophisticated pipeline to ensure fluid interaction:

1.  **Speech-to-Text (STT)**: Capture's user audio and transcribes it using `Faster-Whisper` (Base/Small models).
2.  **LLM Reasoning**: Streams logic from `Ollama` (Llama 3/Mistral) while concurrently processing context via the RAG layer.
3.  **Sentence Buffering**: Intelligent text collation to ensure natural intonation.
4.  **Text-to-Speech (TTS)**: Generates high-fidelity audio chunks using `Piper` for immediate playback.

---

## 🛠️ Tech Stack

-   **Backend**: [FastAPI](https://fastapi.tiangolo.com/) (Python)
-   **Frontend**: [React](https://react.dev/) + [Vite](https://vitejs.dev/) + [Tailwind CSS](https://tailwindcss.com/)
-   **Intelligence**: [Ollama](https://ollama.com/) (LLM), [Faster-Whisper](https://github.com/SYSTRAN/faster-whisper) (STT), [Piper](https://github.com/rhasspy/piper) (TTS)
-   **Database**: [MongoDB](https://www.mongodb.com/) (Beanie ODM)
-   **Caching**: [Redis](https://redis.io/)
-   **Infrastructure**: [Docker](https://www.docker.com/) & [Docker Compose](https://docs.docker.com/compose/)

---

## 🚀 Getting Started

### Prerequisites

-   Docker and Docker Compose installed.
-   [Ollama](https://ollama.com/) running on the host machine (or as a container).

### Installation

1.  **Clone the Repository**:
    ```bash
    git clone https://github.com/your-repo/rag-voice-agent.git
    cd rag-voice-agent
    ```

2.  **Configure Environment**:
    Copy the sample environment file and adjust your settings:
    ```bash
    cp .env.dev .env
    ```

3.  **Launch with Docker**:
    ```bash
    docker-compose -f docker-compose.dev.yml up --build
    ```

4.  **Access the App**:
    Open [http://localhost:5173](http://localhost:5173) in your browser.

---

<p align="center">
  <i>Built with ❤️ for Indus University</i>
</p>
