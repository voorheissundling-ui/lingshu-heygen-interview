export function isRealWhatsAppNumber(value: unknown): boolean {
  const number = String(value || '').trim();
  return Boolean(number) && !number.toLowerCase().startsWith('social:');
}

