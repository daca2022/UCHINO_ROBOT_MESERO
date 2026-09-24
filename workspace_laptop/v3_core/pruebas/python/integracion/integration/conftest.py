"""
conftest.py — Shared fixtures for v3_core integration tests.
"""
import asyncio
import os
import sys
import pytest

# Ensure v3_core is on the path
_PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../.."))
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)


@pytest.fixture
def event_loop():
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


@pytest.fixture
def backend_url():
    """Return the backend API base URL."""
    return os.getenv("BACKEND_URL", "http://localhost:3003")
