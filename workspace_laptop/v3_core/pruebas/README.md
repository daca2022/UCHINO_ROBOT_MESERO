# Pruebas y Demos — Uchino Robot Mesero UTEC

Carpeta unificada de todas las pruebas, demos y prototipos del sistema v3.
Organizado por categoría: demos funcionales, tests unitarios, tests de integración.

---

## Estructura

```
pruebas/
├── demos/                      # Demos y prototipos funcionales
│   ├── chipi_voz.html          # Demo de voz (WebSocket + TTS/STT)
│   ├── chipi_voz_rvc.html      # Demo de voz con RVC
│   └── chipi_vivo.html         # Demo en vivo del robot
├── frontend/
│   └── test_chipi.html         # Pagina de prueba frontend (chat + TTS)
├── nodejs/
│   ├── backend_api/            # Tests del backend Node.js (Express + WebSocket)
│   └── llm_brain/              # Tests del modulo LLM (Qwen, adapters, fallback)
└── python/
    ├── integracion/            # Tests de integracion del pipeline Python
    ├── ros2_control/           # Tests del modulo ROS2
    └── scripts/                # Scripts utilitarios de prueba (audio, STT, sink)
```

---

## Demos

| Archivo | Descripcion | Origen |
|---|---|---|
| `demos/chipi_voz.html` | Demo de voz - WebSocket entre ESP32 y backend con TTS/STT | `v3_core/` raiz |
| `demos/chipi_voz_rvc.html` | Demo de voz con RVC (Retrieval Voice Conversion) | `v3_core/` raiz |
| `demos/chipi_vivo.html` | Dashboard en vivo del robot | `frontend_ui/` |
| `frontend/test_chipi.html` | Pagina de prueba - chat + TTS | `frontend_ui/public/` |

## Tests Node.js

### `nodejs/backend_api/`
| Archivo | Descripcion |
|---|---|
| `CocinaService.test.mjs` | Tests del servicio de cocina (pedidos en tiempo real) |
| `integration.test.mjs` | Tests de integracion del backend |
| `Pedido.test.mjs` | Tests del modelo de pedidos |

### `nodejs/llm_brain/`
| Archivo | Descripcion |
|---|---|
| `LlmOrchestrator.test.mjs` | Tests del orquestador de LLM |
| `MockLlmProvider.test.mjs` | Tests del proveedor mock de LLM |
| `setup.mjs` | Configuracion compartida de tests |
| `adapters/QwenCloudAdapter.test.mjs` | Tests del adapter Qwen cloud |
| `bridge/llmBridgeRouter.test.mjs` | Tests del bridge router |
| `config/prompts.test.mjs` | Tests de configuracion de prompts |
| `config/resilience.test.mjs` | Tests de resiliencia |
| `helpers/fixtures.mjs` | Fixtures compartidos |
| `helpers/mockFetch.mjs` | Mock de fetch para tests |
| `helpers/mockLlmProvider.mjs` | Mock de proveedor LLM |
| `helpers/smoke.test.mjs` | Smoke tests |
| `integration/fallback_integration.test.mjs` | Tests de integracion con fallback |
| `services/CircuitBreaker.test.mjs` | Tests del circuit breaker |
| `services/FallbackManager.test.mjs` | Tests del gestor de fallback |

## Tests Python

### `python/integracion/`
| Archivo | Descripcion |
|---|---|
| `conftest.py` | Configuracion pytest compartida |
| `test_e2e_qwen_pipeline.py` | Test end-to-end del pipeline Qwen |
| `integration/conftest.py` | Configuracion pytest de integracion |
| `integration/run_tests.py` | Script para ejecutar tests de integracion |
| `integration/test_full_pipeline.py` | Test del pipeline completo |
| `integration/test_health_check.py` | Test de health check |

### `python/ros2_control/`
| Archivo | Descripcion |
|---|---|
| `RecorridoService.test.mjs` | Tests del servicio de recorridos ROS2 |

---

## Notas

- Los archivos se movieron desde sus ubicaciones originales (ver columna "Origen").
- Las carpetas de origen (`tests/`, `llm_brain/tests/`, `backend_api/tests/`, `ros2_control/tests/`) quedaron vacias como marcadores de posicion.
- Los tests de `WhisperLiveKit/` NO se movieron (repositorio externo).
- Ningun archivo fue modificado, solo reubicado.
- `v1_html/` (prototipos V1 HTML) fue eliminado por obsoleto, completamente reemplazado por el frontend React.
