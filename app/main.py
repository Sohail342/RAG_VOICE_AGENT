"""Main FastAPI application."""

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.v1.api import api_v1_router
from app.core.config import settings
from app.database.mongo import close_db, init_db
from app.voice.dependencies import close_voice_services, init_voice_services


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
    from app.llm.prompt_templates import get_prompt_template

    response = await get_prompt_template(
        "What is the capital of France?", "llama3.2:3b"
    )
    print(f"LLM response: {response}")
    return {"status": "ok"}
