// Lucide icons served from /public/icons. `invert` flips them for dark fills.
export default function Icon({ name, size = 16, invert = false }) {
  return <img src={`/icons/${name}.svg`} width={size} height={size} alt="" className={invert ? 'invert' : undefined} />;
}
