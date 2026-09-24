# MODULO: esp32_firmware (V3)

## Propósito
Firmware del ESP32 del Robot Mesero. Funciona como el "Sistema Nervioso Periférico" del robot. Gestiona la captura de audio (2x INMP441), la reproducción de audio (2x MAX98357A), el radar espacial (AudioCompass/TDoA), y mantiene una conexión **WebSocket Binaria Bidireccional** constante con el "Cerebro" (Node.js / PLN).

## Arquitectura de Streaming (La Base del PLN)
El sistema está diseñado para **Streaming en Tiempo Real (Full-Duplex)**.
- **No graba archivos WAV:** Lee fragmentos de audio (PCM 16-bit) directamente del hardware I2S y los dispara por la red instantáneamente mediante WebSocket binario.
- **Protocolo Eficiente:** Utiliza una estructura con un `MAGIC_BYTE (0xA5)` para mezclar el envío de audio de alta velocidad y datos de telemetría (como el ángulo del radar) en el mismo "tubo" de conexión.
- **Preparado para Agentes de Voz:** Esta es la arquitectura óptima para conectar con STT (Speech-to-Text), LLM (Cerebro) y TTS (Text-to-Speech). Mientras el usuario habla, el audio viaja al backend; en cuanto el TTS del backend genera la respuesta, viaja de vuelta al ESP32 y sale por los altavoces sin abrir ni cerrar conexiones.

## Archivos clave
- `src/main.cpp`: **[ACTIVO]** Punto de entrada unificado. Contiene la lógica de I2S (Micrófono y Altavoz), cálculo del radar, y el cliente WebSocket.
- `platformio.ini`: Configuración de PlatformIO (librerías, OTA, monitor serial).
- `test_loopback_v3.mjs`: Servidor Node.js local de prueba que imita al backend final haciendo rebotar el audio (para probar latencia).
- *Nota:* Las carpetas antiguas (`src/audio/`, `src/network/`, etc.) se han mantenido temporalmente como respaldo histórico, pero la versión V3 está unificada en `main.cpp` para maximizar la velocidad de los buffers I2S.

## Dependencias
- PlatformIO: platform `espressif32`, board `esp32dev`, framework `arduino`.
- Librerías: `gilmaimon/ArduinoWebsockets@^0.5.4` (Fundamental para el streaming binario).
- Servidor: Espera conectarse a `ws://192.168.1.2:3005/ws/robot`.
