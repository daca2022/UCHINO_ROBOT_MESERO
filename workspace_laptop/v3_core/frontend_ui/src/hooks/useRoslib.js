import { useState, useEffect, useRef, useCallback } from 'react';

const DEFAULT_URL = 'ws://localhost:9090';
const RECONNECT_DELAY = 3000;

/**
 * Hook to connect to rosbridge_server via WebSocket (default ws://localhost:9090).
 * Provides publish/subscribe to ROS2 topics.
 *
 * @param {object}   opts
 * @param {string}   [opts.url]       WebSocket URL (default: ws://localhost:9090)
 * @param {boolean}  [opts.autoConnect=true]
 * @returns {{ connected: boolean, publish: Function, subscribe: Function, unsubscribe: Function, callService: Function }}
 */
export function useRoslib(opts = {}) {
  const { url = DEFAULT_URL, autoConnect = true } = opts;

  const wsRef = useRef(null);
  const [connected, setConnected] = useState(false);
  const subscribersRef = useRef(new Map());
  const pendingRef = useRef([]);

  // Build a rosbridge message
  function makeId() {
    return `ros_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);

      subscribersRef.current.forEach((cb, topic) => {
        ws.send(JSON.stringify({
          op: 'subscribe',
          id: makeId(),
          topic,
          type: typeof cb === 'string' ? cb : 'std_msgs/msg/String',
        }));
      });

      while (pendingRef.current.length) {
        ws.send(JSON.stringify(pendingRef.current.shift()));
      }
    };

    ws.onclose = () => {
      setConnected(false);
      if (autoConnect) {
        setTimeout(connect, RECONNECT_DELAY);
      }
    };

    ws.onerror = () => {};

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.op === 'publish' && msg.topic) {
          const cb = subscribersRef.current.get(msg.topic);
          if (typeof cb === 'function') {
            cb(msg.msg);
          }
        }
      } catch {}
    };
  }, [url, autoConnect]);

  useEffect(() => {
    if (autoConnect) connect();

    return () => {
      const ws = wsRef.current;
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
    };
  }, [connect, autoConnect]);

  /**
   * Publish a message to a ROS2 topic.
   * @param {string} topic   - ROS topic name (e.g. '/cmd_vel')
   * @param {object} msg     - Message payload
   * @param {string} [type]  - Message type (default: 'std_msgs/msg/String')
   */
  const publish = useCallback((topic, msg, type = 'std_msgs/msg/String') => {
    const payload = {
      op: 'publish',
      id: makeId(),
      topic,
      msg,
    };
    if (type) payload.type = type;

    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    } else {
      pendingRef.current.push(payload);
    }
  }, []);

  /**
   * Subscribe to a ROS2 topic.
   * @param {string}   topic    - ROS topic name
   * @param {Function} callback - Called with message payload on each message
   * @param {string}   [type]   - Message type (default: 'std_msgs/msg/String')
   * @returns {Function} unsubscribe function
   */
  const subscribe = useCallback((topic, callback, type = 'std_msgs/msg/String') => {
    subscribersRef.current.set(topic, callback);

    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        op: 'subscribe',
        id: makeId(),
        topic,
        type,
      }));
    }

    // Return unsubscribe function
    return () => {
      subscribersRef.current.delete(topic);
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          op: 'unsubscribe',
          id: makeId(),
          topic,
        }));
      }
    };
  }, []);

  /**
   * Unsubscribe from a ROS2 topic.
   */
  const unsubscribe = useCallback((topic) => {
    subscribersRef.current.delete(topic);
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        op: 'unsubscribe',
        id: makeId(),
        topic,
      }));
    }
  }, []);

  /**
   * Call a ROS2 service.
   * @param {string} service - Service name
   * @param {object} [args]  - Service request arguments
   * @returns {Promise<object>} Service response
   */
  const callService = useCallback((service, args = {}) => {
    return new Promise((resolve, reject) => {
      const ws = wsRef.current;
      if (ws?.readyState !== WebSocket.OPEN) {
        reject(new Error('WebSocket not connected'));
        return;
      }

      const id = makeId();

      const handler = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.op === 'service_response' && msg.id === id) {
            ws.removeEventListener('message', handler);
            if (msg.result === false) {
              reject(new Error(msg.values || 'Service call failed'));
            } else {
              resolve(msg.values);
            }
          }
        } catch {
          // ignore
        }
      };

      ws.addEventListener('message', handler);

      ws.send(JSON.stringify({
        op: 'call_service',
        id,
        service,
        args,
      }));

      // Timeout after 10s
      setTimeout(() => {
        ws.removeEventListener('message', handler);
        reject(new Error(`Service call to ${service} timed out`));
      }, 10000);
    });
  }, []);

  return { connected, publish, subscribe, unsubscribe, callService, connect };
}
