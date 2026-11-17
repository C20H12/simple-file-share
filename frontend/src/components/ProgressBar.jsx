export default function ProgressBar({ value, className = '' }) {
  return (
    <div className={`bar ${className}`}>
      <div style={{ width: `${value}%` }} />
    </div>
  );
}
