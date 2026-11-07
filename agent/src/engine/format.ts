// Fixed-point numbers as the log and the console show them: 2070.5, never 2070.500000000000000000.
export const formatFixedPoint = (value: bigint, decimals: number): string => {
  const negative = value < 0n;
  const magnitude = (negative ? -value : value).toString().padStart(decimals + 1, '0');
  const whole = magnitude.slice(0, magnitude.length - decimals);
  const fraction = magnitude.slice(magnitude.length - decimals).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
};

// A price with the vault's 18 decimals
export const formatPrice = (value: bigint) => formatFixedPoint(value, 18);
