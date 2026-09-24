import os
import sys
import pytest

_PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)


def pytest_configure(config):
    config.addinivalue_line(
        "markers",
        "requires_api: mark test as requiring real external API keys"
    )


@pytest.fixture
def backend_url():
    return os.getenv("BACKEND_URL", "http://localhost:3003")


@pytest.fixture
def llm_client(backend_url):
    from dialogue.llm_client import LlmClient
    return LlmClient(base_url=f"{backend_url}/api/llm")


@pytest.fixture
def mock_httpx_response():
    from unittest.mock import MagicMock

    def _make(status_code=200, json_data=None, text=""):
        resp = MagicMock()
        resp.status_code = status_code
        resp.json.return_value = json_data or {}
        resp.text = text
        return resp
    return _make


@pytest.fixture
def mock_httpx_client(mock_httpx_response):
    from unittest.mock import AsyncMock, MagicMock

    def _make(response=None):
        mock_client = MagicMock()
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=None)
        mock_client.post = AsyncMock(return_value=(response or mock_httpx_response()))
        return mock_client
    return _make
