# memory

## Propósito

Implementa el sistema de memoria de Uchino usando mem0 para memoria a largo plazo y person memory para perfiles de usuarios individuales. Extrae informacion semantica de las conversaciones, la almacena con embeddings locales (sentence-transformers), y la recupera contextualmente para que Uchino recuerde preferencias, nombres e interacciones previas.

## Tecnologías

- Python 3.12
- mem0 (memoria conversacional)
- sentence-transformers (embeddings locales, sin Gemini)
- OpenRouter LLM (para extraccion semantica)
- ChromaDB (almacenamiento vectorial)

## Archivos principales

- `person_memory.py` — Gestion de memoria por usuario (preferencias, historial)
- `semantic_extractor.py` — Extraccion de informacion relevante de conversaciones
- `function_handlers.py` — Handlers para operaciones de memoria (guardar, buscar, actualizar)

## Interacciones

- **Recibe**: Conversaciones del dialogo para extraccion de memoria
- **Almacena en**: ChromaDB (vectores), PostgreSQL (datos estructurados)
- **Provee a**: `dialogue/` (contexto de memoria para respuestas), `orchestrator/` (recuperacion rapida)
- **Coordina con**: `memory_db/` (SQLite + PostgreSQL + Redis)
