# Stage 1: Builder
FROM python:3.12-slim AS builder
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential curl \
    && rm -rf /var/lib/apt/lists/*

# Install uv
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

# Copy dependency files
COPY pyproject.toml ./

# Install packages into a virtualenv
RUN uv lock && uv sync --no-dev --frozen --no-cache


# Stage 2: Runtime
FROM python:3.12-slim
WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PATH="/app/.venv/bin:$PATH"

RUN apt-get update && apt-get install -y --no-install-recommends \
    wget \
    ffmpeg \
    libsndfile1 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -m appuser


#  copy uv binaries from builder stage
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

# Use --chown directly in the COPY command.
COPY --from=builder --chown=appuser:appuser /app/.venv /app/.venv

# Copy application code
COPY --chown=appuser:appuser ./app ./app

# Change ownership of app directory to appuser
RUN chown appuser:appuser /app

USER appuser


CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
