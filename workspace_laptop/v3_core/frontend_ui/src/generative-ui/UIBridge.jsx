import { useEffect, useState, useCallback } from 'react';
import { GenerativeOverlay } from './components.jsx';

const WS_PATH = '/ws/ui';

export function UIBridge() {
  const [command, setCommand] = useState(null);

  useEffect(() => {
    let ws;
    let reconnectTimer;

    function connect() {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}${WS_PATH}`);

      ws.onopen = () => {
        // Keepalive ping every 30s
        if (ws.pingTimer) clearInterval(ws.pingTimer);
        ws.pingTimer = setInterval(() => {
          if (ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping' }));
          }
        }, 30000);
      };

      ws.onmessage = (e) => {
        if (typeof e.data !== 'string') return;
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'render_ui') {
            setCommand({ component: msg.component, props: msg.props, ts: Date.now() });
          } else if (msg.type === 'emotion') {
            // Las emociones se manejan via RobotScreen, no por overlay
            window.dispatchEvent(new CustomEvent('chipi-emotion', { detail: msg }));
          } else if (msg.type === 'navigate') {
            window.dispatchEvent(new CustomEvent('chipi-navigate', { detail: msg }));
          } else if (msg.type === 'add-to-cart') {
            window.dispatchEvent(new CustomEvent('chipi-add-to-cart', { detail: msg }));
          }
        } catch {}
      };

      ws.onclose = () => {
        if (ws.pingTimer) clearInterval(ws.pingTimer);
        reconnectTimer = setTimeout(connect, 3000);
      };
    }

    connect();
    return () => {
      clearTimeout(reconnectTimer);
      if (ws?.pingTimer) clearInterval(ws.pingTimer);
      ws?.close();
    };
  }, []);

  const dismiss = useCallback(() => {
    setCommand(null);
  }, []);

  return command ? (
    <GenerativeOverlay
      key={command.ts}
      component={command.component}
      props={command.props}
      onDismiss={dismiss}
    />
  ) : null;
}
