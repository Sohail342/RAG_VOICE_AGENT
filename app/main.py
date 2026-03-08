"""Main FastAPI application."""

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.v1.api import api_v1_router
from app.core.config import settings
from app.database.mongo import close_db, init_db
from app.voice.dependencies import close_voice_services, init_voice_services

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
)


def create_application() -> FastAPI:
    """Create FastAPI app with middleware and routes."""

    application = FastAPI(
        title=settings.PROJECT_NAME,
        description=settings.PROJECT_DESCRIPTION,
        version="0.1.0",
        openapi_url=None
        if settings.ENVIRONMENT == "production"
        else f"{settings.API_V1_STR}/openapi.json",
        docs_url=None
        if settings.ENVIRONMENT == "production"
        else f"{settings.API_V1_STR}/docs",
        redoc_url=None
        if settings.ENVIRONMENT == "production"
        else f"{settings.API_V1_STR}/redoc",
        lifespan=lifespan,
    )

    # Set up CORS
    is_dev = settings.ENVIRONMENT in ("development", "developement", "dev")

    if settings.BACKEND_CORS_ORIGINS:
        application.add_middleware(
            CORSMiddleware,
            allow_origins=["*"]
            if is_dev
            else [str(origin) for origin in settings.BACKEND_CORS_ORIGINS],
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )
    else:
        # Fallback if empty
        application.add_middleware(
            CORSMiddleware,
            allow_origins=["*"],
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )
    application.include_router(api_v1_router)
    return application


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Initialize DB
    await init_db()

    # Initialize Voice Services (STT, TTS, LLM)
    init_voice_services()

    # Initialize Qdrant RAG securely within lifespan
    try:
        import asyncio

        from app.core.rag import get_rag

        # Run initialization in thread so it doesn't block the ASGI loop
        app.state.rag = await asyncio.to_thread(get_rag)
    except Exception as e:
        logging.getLogger(__name__).error(f"Failed to load RAG system: {e}")

    # Warmup Ollama model in the background
    async def warmup_ollama():
        import aiohttp

        try:
            logger = logging.getLogger(__name__)
            logger.info(f"Warming up Ollama model '{settings.OLLAMA_MODEL}'...")
            async with aiohttp.ClientSession() as session:
                payload = {
                    "model": settings.OLLAMA_MODEL,
                    "messages": [{"role": "user", "content": "hi"}],
                    "keep_alive": -1,
                }
                url = f"{settings.OLLAMA_API_BASE_URL.rstrip('/')}/api/chat"
                async with session.post(url, json=payload) as response:
                    await response.text()
                    logger.info("Ollama model warmed up and loaded into VRAM.")
        except Exception as e:
            logging.getLogger(__name__).error(f"Failed to warm up Ollama model: {e}")

    import asyncio

    asyncio.create_task(warmup_ollama())

    try:
        yield
    finally:
        # Cleanup Resources
        await close_voice_services()
        await close_db()


app = create_application()


@app.get("/")
def root():
    """Root endpoint."""
    return {
        "message": f"Welcome to {settings.PROJECT_NAME}",
        "version": "0.1.0",
        "docs": f"{settings.API_V1_STR}/docs",
    }


@app.get("/health")
async def health():
    return {"status": "ok"}
