import { useRef, useEffect, useState, useCallback } from 'react';
import { useRoslib } from '../hooks/useRoslib.js';

const ZONES = [
  { name: 'Entrada', x: 0, y: 0, w: 3, h: 3, color: '#22D3EE30' },
  { name: 'Sala A', x: 3, y: 0, w: 4, h: 4, color: '#F59E0B30' },
  { name: 'Sala B', x: 7, y: 0, w: 4, h: 4, color: '#A855F730' },
  { name: 'Cocina', x: 3, y: 5, w: 5, h: 3, color: '#F43F5E30' },
];

export default function RosMap() {
  const canvasRef = useRef(null);
  const [mapInfo, setMapInfo] = useState(null);
  const [robotPose, setRobotPose] = useState(null);
  const [status, setStatus] = useState('Conectando...');
  const imageDataRef = useRef(null);

  const ros = useRoslib({ url: 'ws://localhost:9090' });

  useEffect(() => {
    if (ros.connected) {
      setStatus('Suscribiendo al mapa...');
      ros.subscribe('/map', (msg) => {
        if (!msg?.info) return;
        setMapInfo(msg.info);
        try {
          const binary = atob(msg.data);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          const img = new ImageData(msg.info.width, msg.info.height);
          for (let i = 0; i < bytes.length; i++) {
            const val = bytes[i];
            let r, g, b, a;
            if (val === 0) { r = 200; g = 200; b = 210; a = 255; }
            else if (val === 100) { r = 30; g = 30; b = 40; a = 255; }
            else { r = 120; g = 120; b = 130; a = 255; }
            img.data[i * 4] = r;
            img.data[i * 4 + 1] = g;
            img.data[i * 4 + 2] = b;
            img.data[i * 4 + 3] = a;
          }
          imageDataRef.current = img;
          setStatus('Mapa recibido');
          requestAnimationFrame(draw);
        } catch {
          setStatus('Error decodificando mapa');
        }
      });

      ros.subscribe('/amcl_pose', (msg) => {
        const p = msg?.pose?.pose;
        if (p) {
          setRobotPose({ x: p.position.x, y: p.position.y });
          requestAnimationFrame(draw);
        }
      });
    } else {
      setStatus('Esperando conexión ROS2...');
    }
  }, [ros.connected]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    if (!mapInfo || !imageDataRef.current) {
      ctx.fillStyle = '#0B0A10';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#64748B';
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(status, w / 2, h / 2);
      return;
    }

    const scaleX = w / mapInfo.width;
    const scaleY = h / mapInfo.height;

    ctx.save();
    ctx.scale(scaleX, scaleY);
    const tmp = document.createElement('canvas');
    tmp.width = mapInfo.width;
    tmp.height = mapInfo.height;
    tmp.getContext('2d').putImageData(imageDataRef.current, 0, 0);
    ctx.drawImage(tmp, 0, 0);
    ctx.restore();

    const origin = mapInfo.origin;
    const res = mapInfo.resolution;

    function worldToPx(wx, wy) {
      const px = (wx - origin.position.x) / res;
      const py = mapInfo.height - (wy - origin.position.y) / res;
      return { x: px * scaleX, y: py * scaleY };
    }

    ZONES.forEach(z => {
      const tl = worldToPx(z.x, z.y + z.h);
      const br = worldToPx(z.x + z.w, z.y);
      ctx.fillStyle = z.color;
      ctx.fillRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
      ctx.strokeStyle = z.color.replace('30', '90');
      ctx.lineWidth = 1;
      ctx.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
      ctx.fillStyle = '#f0f0f5';
      ctx.font = '10px sans-serif';
      ctx.fillText(z.name, tl.x + 4, tl.y + 12);
    });

    if (robotPose) {
      const pos = worldToPx(robotPose.x, robotPose.y);
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, 8, 0, Math.PI * 2);
      ctx.fillStyle = '#22D3EE';
      ctx.fill();
      ctx.shadowColor = '#22D3EE';
      ctx.shadowBlur = 15;
      ctx.strokeStyle = '#22D3EE';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.shadowBlur = 0;

      ctx.fillStyle = '#22D3EE';
      ctx.font = 'bold 11px monospace';
      ctx.fillText('UCHINO', pos.x + 12, pos.y - 10);
    }
  }, [mapInfo, robotPose, status]);

  useEffect(() => { draw(); }, [draw]);

  return (
    <div className="w-full h-full flex flex-col gap-3">
      <div className="flex items-center justify-between glass rounded-xl px-4 py-2 border border-chipi-border">
        <div className="flex items-center gap-2 text-xs text-text-secondary">
          <span className={`w-2 h-2 rounded-full ${ros.connected ? 'bg-neon-green glow-pulse-green' : 'bg-neon-rose'}`} />
          <span>{ros.connected ? 'ROS2 Conectado' : 'ROS2 Desconectado'}</span>
          <span className="text-text-dim">|</span>
          <span>{status}</span>
        </div>
        {robotPose && (
          <span className="text-[10px] font-mono text-neon-cyan">
            X:{robotPose.x.toFixed(2)} Y:{robotPose.y.toFixed(2)}
          </span>
        )}
      </div>
      <div className="flex-1 rounded-2xl overflow-hidden border border-chipi-border relative bg-chipi-surface">
        <canvas ref={canvasRef} width={800} height={600} className="w-full h-full object-contain" />
      </div>
    </div>
  );
}
