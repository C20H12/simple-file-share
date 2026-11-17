export default function SegmentedControl({ name, options, value, onChange }) {
  return (
    <div className="seg seg-wide">
      {options.map((opt) => (
        <label key={opt.value} className="seg-opt">
          <input type="radio" name={name} checked={value === opt.value} onChange={() => onChange(opt.value)} />
          <span>{opt.label}</span>
        </label>
      ))}
    </div>
  );
}
