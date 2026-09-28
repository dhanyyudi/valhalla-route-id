/** `1 j 56 mnt 43 dtk`, from native's fractional seconds. */
export function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  return [hours ? `${hours} j` : '', minutes ? `${minutes} mnt` : '', `${rest} dtk`].filter(Boolean).join(' ');
}

/** Kilometres with Indonesian thousands/decimal separators. */
export function formatKilometers(kilometers: number): string {
  return `${kilometers.toLocaleString('id-ID', { maximumFractionDigits: 3 })} km`;
}

/** Byte counts in the units the SDK reports them in, with the exact value kept. */
export function formatBytes(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  return `${mb.toLocaleString('id-ID', { maximumFractionDigits: 1 })} MB (${bytes.toLocaleString('id-ID')} B)`;
}

/** Speed readout, rounded to whole km/h. */
export function formatSpeed(kmh: number): string {
  return `${Math.round(kmh).toLocaleString('id-ID')} km/j`;
}

/** `9 mnt`, `1 j 05 mnt`, `45 dtk`: minute precision for tables and map labels. */
export function formatShortDuration(seconds: number): string {
  const total = Math.round(seconds);
  if (total < 60) return `${total} dtk`;
  const minutes = Math.round(total / 60);
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours} j ${String(minutes % 60).padStart(2, '0')} mnt` : `${minutes} mnt`;
}
