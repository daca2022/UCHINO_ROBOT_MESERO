import { useState, useEffect, useCallback, useRef } from 'react';

export function useWebSocket(path, auth = null) {
  const [data, setData] = useState(null);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const authToken = typeof auth === 'string' ? auth : auth?.token || '';
  const authSessionId = typeof auth === 'object' && auth ? auth.sessionId || '' : '';

  useEffect(() => {
    let active = true;

    function connect() {
      if (!active) return;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}${path}`);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      ws.onopen = () => {
        if (authToken) ws.send(JSON.stringify({ type: 'auth', token: authToken, session_id: authSessionId || undefined }));
        if (active) setConnected(true);
      };
      ws.onclose = () => {
        if (active) setConnected(false);
        wsRef.current = null;
        reconnectTimerRef.current = setTimeout(connect, 3000);
      };
      ws.onmessage = (e) => {
        if (!active) return;
        if (typeof e.data === 'string') {
          try { setData(JSON.parse(e.data)); } catch {}
        }
      };
    }

    connect();

    return () => {
      active = false;
      clearTimeout(reconnectTimerRef.current);
      const ws = wsRef.current;
      if (ws) {
        ws.onclose = null;
        ws.close();
        wsRef.current = null;
      }
    };
  }, [path, authToken, authSessionId]);

  const send = useCallback((msg) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
    }
  }, []);

  return { data, connected, send };
}

export function useApi(url, options = {}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [reloadToken, setReloadToken] = useState(0);
  const headersKey = JSON.stringify(options.headers || {});

  useEffect(() => {
    let cancelled = false;
    const load = (showLoading = true) => {
      if (showLoading) setLoading(true);
      fetch(url, { headers: options.headers || {} })
        .then(r => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        })
        .then(d => {
          if (!cancelled) {
            setData(d);
            setError(null);
            setLoading(false);
          }
        })
        .catch(e => {
          if (!cancelled) {
            setError(e);
            setLoading(false);
          }
        });
    };

    load();

    if (options.interval) {
      const timer = setInterval(() => load(false), options.interval);
      return () => { cancelled = true; clearInterval(timer); };
    }
    return () => { cancelled = true; };
  }, [url, options.interval, headersKey, reloadToken]);

  return { data, loading, error, reload: () => setReloadToken(value => value + 1) };
}
