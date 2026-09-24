import { useState, useEffect } from 'react';
import { useAuth } from '../AuthContext';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts';

const COLORS = ['#22c55e', '#ef4444'];

function MetricCard({ label, value, sublabel }) {
  return (
    <div className="metric-card">
      <span className="metric-label">{label}</span>
      <span className="metric-value">{value}</span>
      {sublabel && <span className="metric-sublabel">{sublabel}</span>}
    </div>
  );
}

export default function LLMMetrics() {
  const { token } = useAuth();
  const [metrics, setMetrics] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const fetchMetrics = async () => {
      try {
        const res = await fetch('/api/admin/llm-metrics', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        setMetrics(data);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };
    fetchMetrics();
  }, [token]);

  if (loading) return <div className="panel-loading">Cargando métricas LLM...</div>;
  if (error) return <div className="panel-error">Error: {error}</div>;
  if (!metrics) return <div className="panel-error">Sin datos</div>;

  const totalCalls = metrics.totalCalls || metrics.total_calls || 0;
  const fallbacks = metrics.fallback_count || metrics.fallbacks || 0;
  const avgLatency = metrics.avg_latency_ms ?? metrics.avgLatency ?? metrics.avg_latency ?? 'N/A';
  const errors = metrics.errors || 0;
  const provider = metrics.provider || 'deepseek/deepseek-v4-flash';

  const pieData = [
    { name: 'Exitosas', value: Math.max(totalCalls - fallbacks, 0) },
    { name: 'Fallbacks', value: fallbacks },
  ];

  return (
    <div className="llm-metrics">
      <div className="metrics-grid">
        <MetricCard label="Provider" value={provider} />
        <MetricCard label="Total Calls" value={totalCalls} />
        <MetricCard label="Fallbacks" value={fallbacks} sublabel={`${totalCalls > 0 ? ((fallbacks / totalCalls) * 100).toFixed(1) : 0}% del total`} />
        <MetricCard label="Avg Latency" value={typeof avgLatency === 'number' ? `${avgLatency}ms` : avgLatency} />
        <MetricCard label="Errors" value={errors} />
      </div>

      <div className="pie-chart-container">
        <h3 className="chart-title">Fallback Ratio</h3>
        <ResponsiveContainer width="100%" height={200}>
          <PieChart>
            <Pie
              data={pieData}
              cx="50%"
              cy="50%"
              innerRadius={50}
              outerRadius={80}
              paddingAngle={4}
              dataKey="value"
              label={({ name, value }) => `${name}: ${value}`}
            >
              {pieData.map((_, index) => (
                <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
              ))}
            </Pie>
            <Tooltip />
          </PieChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
