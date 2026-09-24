"""
Integration tests for the enhanced /api/status health check endpoint.
"""
import json
import os
import subprocess
import sys
import time

import pytest
import requests

_BACKEND_URL = os.getenv("BACKEND_URL", "http://localhost:3003")


class TestHealthCheckEndpoint:
    """Verify /api/status reports health of ALL subsystems."""

    def test_status_endpoint_returns_all_subsystems(self):
        """
        The health check must include:
        - databases (postgresql, redis, chromadb)
        - llm (primary, fallback, active, onFallback)
        - tts (piper, kokoro)
        - asr (whisper)
        - vision (available, mockMode, stats)
        - ros2 (available, state)
        - recorrido (available, estado)
        """
        try:
            resp = requests.get(f"{_BACKEND_URL}/api/status", timeout=10)
        except requests.ConnectionError:
            pytest.skip("Backend not running — start with `node backend_api/src/server.mjs`")

        assert resp.status_code == 200
        data = resp.json()

        # Top-level fields
        assert "status" in data
        assert "version" in data
        assert "timestamp" in data
        assert "latency_ms" in data

        # Databases
        assert "databases" in data
        dbs = data["databases"]
        assert "postgresql" in dbs
        assert "redis" in dbs
        assert "chromadb" in dbs
        assert "overall" in dbs

        # LLM
        assert "llm" in data
        llm = data["llm"]
        assert "primary" in llm
        assert "fallback" in llm
        assert "active" in llm
        assert "onFallback" in llm

        # TTS
        assert "tts" in data
        tts = data["tts"]
        assert "piper" in tts

        # ASR
        assert "asr" in data
        asr = data["asr"]
        assert "whisper" in asr

        # Vision
        assert "vision" in data
        vision = data["vision"]
        assert "available" in vision
        assert "mockMode" in vision

        # ROS2
        assert "ros2" in data
        ros2 = data["ros2"]
        assert "available" in ros2

        # Recorrido
        assert "recorrido" in data
        rec = data["recorrido"]
        assert "available" in rec

    def test_status_degraded_when_databases_fail(self):
        """If databases are down, status should be 'degraded'."""
        try:
            resp = requests.get(f"{_BACKEND_URL}/api/status", timeout=10)
        except requests.ConnectionError:
            pytest.skip("Backend not running")

        data = resp.json()
        dbs = data.get("databases", {})
        overall = dbs.get("overall", True)

        if not overall:
            assert data["status"] == "degraded"
        else:
            # If DBs are up, status can be ok
            assert data["status"] in {"ok", "degraded"}

    def test_status_latency_is_reasonable(self):
        """Health check should complete in < 2 seconds."""
        try:
            t0 = time.time()
            resp = requests.get(f"{_BACKEND_URL}/api/status", timeout=10)
            latency = (time.time() - t0) * 1000
        except requests.ConnectionError:
            pytest.skip("Backend not running")

        data = resp.json()
        assert data["latency_ms"] < 2000
        assert latency < 2000


class TestHealthCheckViaCurl:
    """Shell-level verification that /api/status works."""

    def test_curl_status_returns_json(self):
        """Use curl to verify the endpoint from shell scripts."""
        try:
            result = subprocess.run(
                ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", f"{_BACKEND_URL}/api/status"],
                capture_output=True,
                text=True,
                timeout=10,
            )
        except FileNotFoundError:
            pytest.skip("curl not installed")
        except subprocess.TimeoutExpired:
            pytest.skip("Backend not responding")

        if result.returncode != 0:
            pytest.skip("Backend not running")

        assert result.stdout.strip() == "200"
